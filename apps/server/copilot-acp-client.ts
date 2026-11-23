import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { JsonObject, JsonValue, ModelStreamError } from "@sfield/core";

const maxWireBytes = 4 * 1024 * 1024;
const maxReplyBytes = 96 * 1024;
const toolFilterNotice = /^Info: (?:Disabled tools: |Unknown tool name in the tool allowlist: )/;

export const copilotTokenVariables = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const copilotEnvironmentKeys = new Set([
  ...copilotTokenVariables, "COPILOT_GH_HOST", "GH_HOST",
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "PATHEXT",
  "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

export function copilotEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => copilotEnvironmentKeys.has(key.toUpperCase())));
}

export type CopilotAcpSettings = {
  profile: "copilot_acp";
  command: string;
  env: NodeJS.ProcessEnv;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
};

export type CopilotReply = { text: string; result: JsonObject };

export class CopilotAcpError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }

  toStreamError(): ModelStreamError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function protocolError() {
  return new CopilotAcpError("PROVIDER_STREAM_ERROR", "Copilot CLI returned an invalid ACP message.");
}

function rpcError(error: JsonObject): CopilotAcpError {
  const message = typeof error.message === "string" ? error.message : "";
  if (error.code === -32000 || /unauthorized|unauthenticated|authentication required|log(?:ged)?[ -]?in|sign[ -]?in/i.test(message)) {
    return new CopilotAcpError("PROVIDER_AUTH", "Sign in to Copilot CLI for PZN Lab or set COPILOT_GITHUB_TOKEN.");
  }
  if (/rate.limit|too many requests/i.test(message)) {
    return new CopilotAcpError("PROVIDER_RATE_LIMITED", "Copilot rate limit reached.", true);
  }
  return new CopilotAcpError("PROVIDER_UNAVAILABLE", "Copilot rejected the ACP request. Check Copilot access and LLM_MODEL.");
}

async function* readMessages(stdout: Readable): AsyncGenerator<JsonObject> {
  stdout.setEncoding("utf8");
  let bytes = 0;
  let buffer = "";
  for await (const chunk of stdout as AsyncIterable<string>) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxWireBytes) throw protocolError();
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: JsonObject | undefined;
      try { value = jsonObject(JSON.parse(line) as JsonValue); } catch { throw protocolError(); }
      if (value?.jsonrpc !== "2.0") throw protocolError();
      yield value;
    }
  }
  if (buffer.trim()) throw protocolError();
}

export async function runCopilotPrompt(
  settings: CopilotAcpSettings,
  cliHome: string,
  prompt: JsonValue[],
  signal: AbortSignal,
  onPrompt: (request: JsonObject) => void,
): Promise<CopilotReply> {
  const workspace = await mkdtemp(resolve(tmpdir(), "pzn-acp-"));
  try {
    if (signal.aborted) throw new CopilotAcpError("CANCELLED", "Copilot request cancelled.");
    const command = isAbsolute(settings.command) || !/[\\/]/.test(settings.command)
      ? settings.command : resolve(settings.command);
    const child = spawn(command, [
      "--acp", "--stdio", "--no-auto-update", "--mode=interactive",
      // A non-empty allowlist disables the CLI's own tools, including future additions.
      "--available-tools=pzn_model_text_only", "--disable-builtin-mcps", "--no-ask-user",
      "--no-custom-instructions", "--disallow-temp-dir", "--sync-session=off", "--model=" + settings.model,
      "--log-dir=" + workspace,
    ], {
      cwd: workspace, env: { ...settings.env, COPILOT_HOME: cliHome }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    const closed = new Promise<void>((done) => { child.once("close", () => done()); });
    let missingCommand = false;
    child.on("error", (error: NodeJS.ErrnoException) => { missingCommand = error.code === "ENOENT"; });
    child.stdin.on("error", () => { /* Process exit is observed through stdout and close. */ });
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();

    const messages = readMessages(child.stdout);
    let nextId = 0;
    function send(value: JsonObject) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
    }

    async function request(
      method: string, params: JsonObject, onUpdate?: (message: JsonObject) => void,
    ): Promise<JsonObject> {
      const id = ++nextId;
      const outgoing = { jsonrpc: "2.0", id, method, params };
      if (method === "session/prompt") onPrompt(outgoing);
      send(outgoing);
      // Use next() so completing one RPC keeps the stream open for the next one.
      for (let entry = await messages.next(); !entry.done; entry = await messages.next()) {
        const message = entry.value;
        if (typeof message.method === "string") {
          if (typeof message.id === "string" || typeof message.id === "number") {
            send(message.method === "session/request_permission"
              ? { id: message.id, result: { outcome: { outcome: "cancelled" } } }
              : { id: message.id, error: { code: -32601, message: "Client method unavailable" } });
          } else if (message.method === "session/update") {
            const update = jsonObject(message.params);
            if (update) onUpdate?.(update);
          }
        } else if (message.id === id) {
          const error = jsonObject(message.error);
          if (error) throw rpcError(error);
          const result = jsonObject(message.result);
          if (!result) throw protocolError();
          return result;
        }
      }
      await closed;
      if (signal.aborted) throw new CopilotAcpError("CANCELLED", "Copilot request cancelled.");
      throw new CopilotAcpError("PROVIDER_UNAVAILABLE", missingCommand
        ? "Copilot CLI was not found. Install it or set COPILOT_ACP_COMMAND."
        : "Copilot CLI closed the ACP connection. Check the CLI version and sign-in.");
    }

    try {
      const initialized = await request("initialize", {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "pzn-lab", version: "1.0.0" },
      });
      if (initialized.protocolVersion !== 1) throw protocolError();
      const { sessionId } = await request("session/new", { cwd: workspace, mcpServers: [] });
      if (typeof sessionId !== "string" || !sessionId) throw protocolError();

      let text = "";
      let bytes = 0;
      const result = await request("session/prompt", { sessionId, prompt }, (message) => {
        if (message.sessionId !== sessionId) return;
        const update = jsonObject(message.update);
        const content = jsonObject(update?.content);
        if (update?.sessionUpdate !== "agent_message_chunk" || content?.type !== "text" || typeof content.text !== "string") return;
        // Copilot sends tool configuration notices as message chunks without a model message ID.
        if (!text && update.messageId === undefined && toolFilterNotice.test(content.text)) return;
        bytes += Buffer.byteLength(content.text);
        if (bytes > maxReplyBytes) throw protocolError();
        text += content.text;
      });
      return { text, result };
    } finally {
      signal.removeEventListener("abort", stop);
      child.stdin.end();
      stop();
      await closed;
    }
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
