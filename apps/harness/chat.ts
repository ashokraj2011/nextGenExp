import { tenantDataDirectory } from "../server/tenant";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ChatHarness, newId, type ChatScope } from "@sfield/core";
import { SqlitePersistence } from "@sfield/store-sqlite";
import { gatewayFromEnv, type GatewaySettings } from "../server/gateway";
import { startApp } from "../server/http";
import { sfieldNamespace } from "../server/runtime";
import type { Bootstrap, ConversationView, TurnView } from "../../packages/contracts/api";
import { decodeChatInput, type TurnPayloads } from "../../packages/contracts/inspector";
import type { ContextRoutingInput } from "../../packages/contracts/model-inputs";
import { connectChat } from "./client";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const balanceDemo = ["Compare available and current balance.", "/reopen", "show me the summary"];

async function readTranscript(dataDir: string, scope: ChatScope) {
  const persistence = new SqlitePersistence({ path: join(tenantDataDirectory(dataDir), "sfield.sqlite") });
  await persistence.init({ namespace: sfieldNamespace, ownerId: newId("owner") });
  try {
    const thread = await new ChatHarness(persistence).open(scope);
    return { conversation: await persistence.getConversation(thread.id), messages: await thread.history() };
  } finally {
    await persistence.close();
  }
}

function printTurn(turn: TurnView) {
  const reply = turn.experience?.question ?? turn.experience?.intro ?? turn.failureCode ?? turn.status;
  console.log("Assistant  " + reply);
  const blocks = turn.experience?.blocks;
  if (blocks?.length) console.log(JSON.stringify(blocks, null, 2));
}

async function runChatLoop(
  gateway: GatewaySettings, provider: string, profileId: string, interactive: boolean, tracePath?: string,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "pzn-chat-harness-"));
  const start = () => startApp({ projectRoot, dataDir, gateway, operatorAuth: "off" });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let terminal: ReturnType<typeof createInterface> | undefined;
  try {
    app = await start();
    let client = await connectChat(app.url);
    const cookie = client.cookie;
    const { personas } = await client.request<Bootstrap>("/api/bootstrap");
    const profile = personas.find(({ personaId }) => personaId === profileId);
    if (!profile) throw new Error("Choose an available profile ID.");
    const conversation = await client.conversation("normal", profileId);
    const sessionId = cookie.split("=")[1];
    if (!sessionId) throw new Error("The app did not open a browser session.");
    const scope = { tenantId: conversation.tenantId, domainId: conversation.domainId, userId: conversation.userId, sessionId, threadId: conversation.id };
    const visibleScope = { ...scope, sessionId: "[REDACTED]" };
    const events: Array<
      | { type: "turn"; turn: TurnView; routerInput?: ReturnType<typeof decodeChatInput>; calls: TurnPayloads }
      | { type: "reopen"; restoredTurnIds: string[]; stored: Awaited<ReturnType<typeof readTranscript>> }
    > = [];

    console.log(JSON.stringify({ provider, profile: profile.displayName, scope: visibleScope }, null, 2));
    if (interactive) {
      console.log("Use /reopen to reload this thread, /logs to inspect the last turn, or /quit to exit.");
      terminal = createInterface({ input: process.stdin, output: process.stdout });
      terminal.setPrompt("You  ");
      terminal.prompt();
    }

    for await (const line of terminal ?? balanceDemo) {
      const message = line.trim();
      if (message === "/quit") break;
      if (message === "/reopen") {
        await app.close();
        app = undefined;
        const stored = await readTranscript(dataDir, scope);
        app = await start();
        client = await connectChat(app.url, cookie);
        const reopened = await client.request<ConversationView>("/api/conversations/" + conversation.id);
        events.push({ type: "reopen", restoredTurnIds: reopened.turns.map(({ id }) => id), stored });
        console.log("Reopened " + reopened.id + " with " + reopened.turns.length + " saved turn(s).");
        console.log(JSON.stringify(stored, null, 2));
      } else if (message === "/logs") {
        const last = events.findLast((entry) => entry.type === "turn");
        console.log(last ? JSON.stringify(last.calls, null, 2) : "Send a chat message to see its calls.");
      } else if (message) {
        if (!interactive) console.log("You  " + message);
        const { turn } = await client.ask(conversation.id, message);
        const calls = await client.request<TurnPayloads>("/api/debug/payloads/" + turn.id);
        const exchange = calls.router?.attempts[0]?.exchange;
        const routerInput = exchange && decodeChatInput(exchange);
        events.push({ type: "turn", turn, routerInput, calls });
        printTurn(turn);
        if (routerInput && typeof routerInput === "object" && !Array.isArray(routerInput)) {
          const { request, recent, summaryFollowUpIntentId } = routerInput as Partial<ContextRoutingInput>;
          console.log(JSON.stringify({ routerInput: { request, recent, summaryFollowUpIntentId } }, null, 2));
        }
      }
      if (terminal && process.stdin.isTTY) terminal.prompt();
    }

    if (tracePath) {
      await app.close();
      app = undefined;
      const report = {
        provider, profile: profile.displayName, scope: visibleScope, events,
        finalTranscript: await readTranscript(dataDir, scope),
      };
      await writeFile(tracePath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log("Saved the trace to " + tracePath);
    }
    if (!interactive) {
      const [comparison, summary] = events.filter((event) => event.type === "turn");
      if (!comparison?.turn.experience?.blocks.some(({ component }) => component === "PznComparison")
        || !summary?.turn.experience?.blocks.some(({ component }) => component === "PznMetricSummary")) {
        throw new Error("The scripted loop did not produce both a balance comparison and a balance summary.");
      }
    }
  } finally {
    terminal?.close();
    try { await app?.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  }
}

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    profile: { type: "string", default: "demo-learner" },
    interactive: { type: "boolean", default: false },
    trace: { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log("npm run chat:harness -- [--interactive] [--provider copilot_acp|gateway|openai] [--profile ID] [--trace PATH]\nCopilot ACP is the default when no provider or office gateway URL is configured.");
} else {
  if (existsSync(join(projectRoot, ".env"))) process.loadEnvFile(join(projectRoot, ".env"));
  if ((values.provider ?? process.env.LLM_PROVIDER) === "openai") {
    if (existsSync(join(projectRoot, ".env.openai"))) process.loadEnvFile(join(projectRoot, ".env.openai"));
  }
  const env = values.provider ? { ...process.env, LLM_PROVIDER: values.provider } : process.env;
  const gateway = gatewayFromEnv(env);
  if (!gateway) throw new Error("Configure a model provider before running the chat harness.");
  await runChatLoop(gateway, gateway.profile ?? "gateway", values.profile, values.interactive, values.trace);
}
