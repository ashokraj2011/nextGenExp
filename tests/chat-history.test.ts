import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChatHarness, newId } from "@sfield/core";
import { SqlitePersistence } from "@sfield/store-sqlite";
import { startApp } from "../apps/server/http";
import { sfieldNamespace } from "../apps/server/runtime";
import { Store } from "../apps/server/store";
import type { ConversationView } from "../packages/contracts/api";
import { portfolioSummaryQuestion } from "../packages/contracts/routing-intents";
import { compileChatReply } from "../packages/experience/compile";
import { testClient, testProject } from "./client";
import { startFixtureGateway } from "./gateway-fixture";

const projectRoot = fileURLToPath(testProject);
const request = "Compare available and current balance.";

test("sfield reloads the transcript and scopes it by user, browser session, and thread", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pzn-sfield-chat-"));
  const gateway = await startFixtureGateway();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  t.after(async () => {
    await app?.close();
    await gateway.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const start = () => startApp({ projectRoot, dataDir, gateway: gateway.settings, mode: "test" });
  app = await start();
  const alice = await testClient(app.url);
  const thread = await alice.conversation();
  const first = (await alice.ask(thread.id, request)).turn;
  assert.equal(first.experience?.blocks[0]?.component, "PznComparison");
  const comparison = gateway.calls.find(({ envelope }) => envelope.inputType === "PznExperienceCompositionInput");
  assert.ok(comparison?.envelope.eligible);
  assert.equal(comparison.envelope.eligible.candidates.some(({ title }) => title === "Balance summary"), false);
  const sameUserOtherThread = await alice.conversation();
  const jordan = await alice.conversation("normal", "demo-returning");
  const otherBrowser = await testClient(app.url);
  const sameUserOtherSession = await otherBrowser.conversation();
  assert.equal((await otherBrowser.response("/api/conversations/" + thread.id)).status, 404);

  for (const [client, id] of [
    [alice, sameUserOtherThread.id], [alice, jordan.id], [otherBrowser, sameUserOtherSession.id],
  ] as const) {
    assert.equal((await client.ask(id, "Show me the summary.")).turn.experience?.question, portfolioSummaryQuestion);
  }

  await app.close();
  app = undefined;
  const persistence = new SqlitePersistence({ path: join(dataDir, "sfield.sqlite") });
  await persistence.init({ namespace: sfieldNamespace, ownerId: newId("owner") });
  try {
    const chat = new ChatHarness(persistence);
    const scope = {
      tenantId: "pzn-local", userId: "demo-learner", sessionId: alice.cookie.split("=")[1], threadId: thread.id,
    };
    const messages = await (await chat.open(scope)).history();
    assert.deepEqual(messages.map(({ role }) => role), ["user", "assistant"]);
    assert.equal((messages[0].content as { text: string }).text, request);
    assert.equal((messages[1].content as { text: string }).text, first.experience?.intro);
    for (const change of [
      { userId: "demo-returning" }, { sessionId: otherBrowser.cookie.split("=")[1] }, { threadId: "unopened-thread" },
    ]) {
      const unrelated = await chat.open({ ...scope, ...change });
      assert.deepEqual(await unrelated.history(), []);
    }
  } finally {
    await persistence.close();
  }

  // Change the old app-side recovery snapshot to verify which store supplies the transcript.
  const db = new DatabaseSync(join(dataDir, "app.sqlite"));
  try {
    const row = db.prepare("SELECT record FROM turns WHERE id = ?").get(first.id) as { record: string };
    const saved = JSON.parse(row.record);
    saved.public.message = "Old app-side copy";
    saved.public.experience.intro = "Old app-side reply";
    saved.public.experience.messages[0].createSurface.dataModel.intro = "Old app-side surface";
    db.prepare("UPDATE turns SET record = ? WHERE id = ?").run(JSON.stringify(saved), first.id);
  } finally {
    db.close();
  }

  app = await start();
  const refreshed = await testClient(app.url, alice.cookie);
  const history = await refreshed.request<ConversationView>("/api/conversations/" + thread.id);
  assert.equal(history.turns[0].message, request);
  assert.equal(history.turns[0].experience?.intro, first.experience?.intro);
  assert.deepEqual(history.turns[0].experience?.messages[0].createSurface.dataModel, { intro: first.experience?.intro });
  assert.equal((await refreshed.turn(first.id)).message, request);
  const resumed = await refreshed.ask(thread.id, "Show me the summary.");
  assert.equal(resumed.turn.experience?.blocks[0]?.component, "PznMetricSummary");
  const router = gateway.calls.findLast(({ envelope }) => envelope.inputType === "PznContextRoutingInput");
  assert.deepEqual(router?.envelope.recent?.map(({ request }) => request), [request]);
});

test("the chat harness imports older threads and keeps history available without a gateway", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pzn-legacy-chat-"));
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    const store = new Store(join(dataDir, "app.sqlite"));
    let session: string;
    let conversationId: string;
    try {
      session = store.session().id;
      const now = Date.now();
      const conversation = store.createConversation(session, "demo-learner", "normal", now);
      conversationId = conversation.id;
      const { turn } = store.accept({
        conversation, requestId: randomUUID(), origin: "message", message: "Hello from a saved chat.",
        selectionMode: "semantic_rerank", now,
      });
      store.finish(turn.public.id, { type: "completed", result: compileChatReply("Welcome back.", "reply", now) }, now);
    } finally {
      store.close();
    }
    app = await startApp({ projectRoot, dataDir, gateway: null });
    const client = await testClient(app.url, "pzn_session=" + session);
    const path = "/api/conversations/" + conversationId;
    const history = await client.request<ConversationView>(path);
    assert.deepEqual(history.turns.map((turn) => [turn.message, turn.experience?.intro]), [
      ["Hello from a saved chat.", "Welcome back."],
    ]);
    const unavailable = await client.ask(conversationId, "Can we continue?");
    assert.equal(unavailable.turn.failureCode, "gateway_unavailable");
    await app.close();
    app = undefined;

    const persistence = new SqlitePersistence({ path: join(dataDir, "sfield.sqlite") });
    await persistence.init({ namespace: sfieldNamespace, ownerId: newId("owner") });
    try {
      const chat = new ChatHarness(persistence);
      const thread = await chat.open({ tenantId: "pzn-local", userId: "demo-learner", sessionId: session, threadId: conversationId });
      const messages = await thread.history();
      assert.deepEqual(messages.map(({ role }) => role), ["user", "assistant", "user"]);
      const [saved, replayed] = await Promise.all(
        [1, 2].map(() => thread.append({ id: "deduplicated-message", role: "user", text: "Retry the same append." })),
      );
      assert.equal(saved.index, replayed.index);
      assert.equal((await thread.history()).length, 4);
      await assert.rejects(
        thread.append({ id: saved.id, role: "user", text: "Another message." }),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
    } finally {
      await persistence.close();
    }
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
