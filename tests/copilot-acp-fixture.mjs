#!/usr/bin/env node
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";

assert.ok(process.argv.includes("--acp"));
assert.ok(process.argv.includes("--stdio"));
assert.ok(process.argv.includes("--available-tools=pzn_model_text_only"));
assert.ok(process.argv.includes("--disable-builtin-mcps"));
assert.equal(process.env.COPILOT_GITHUB_TOKEN, "copilot-acp-fixture-token");
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.COPILOT_ALLOW_ALL, undefined);

const sessionId = "fixture-session";
const pending = new Set();
let prompt;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (session, sessionUpdate, text) => send({
  method: "session/update",
  params: { sessionId: session, update: { sessionUpdate, content: { type: "text", text } } },
});

function respond() {
  const input = JSON.parse(prompt.params.prompt[0].text);
  const user = input.messages.find(({ role }) => role === "user");
  const envelope = JSON.parse(user.parts[0].text);
  const toolResults = input.messages.find(({ role }) => role === "tool_results");
  let answer;
  if (envelope.inputType === "PznContextRoutingInput") {
    assert.ok(envelope.intentCatalog.some(({ intentId }) => intentId === "show_balance"));
    assert.deepEqual(input.appTools, []);
    answer = {
      schemaVersion: "1.1", catalogSnapshotId: envelope.catalogSnapshotId, catalogVersion: envelope.catalog.catalogVersion,
      status: "selected", intentId: "show_balance", summary: "Balance summary", clarificationQuestion: null, replyText: null,
    };
  } else if (!toolResults) {
    const tool = input.appTools.find(({ name }) => name.includes("balance"));
    assert.ok(tool?.parameters);
    answer = { toolCall: { name: tool.name, arguments: {} } };
  } else {
    const result = toolResults.results[0];
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result.content), /1250\.00/);
    const candidate = envelope.eligible.candidates.find(({ title }) => title === "Balance summary");
    assert.ok(candidate);
    answer = {
      schemaVersion: "1.0", decisionId: envelope.eligible.decisionId, status: "ready", intent: envelope.intent,
      introKey: "summary", clarificationQuestion: null, replyText: null, followUpIds: [],
      blocks: [{ blockId: "balance_summary", component: "PznMetricSummary", candidateIds: [candidate.candidateId], variant: "expanded" }],
    };
  }
  const text = JSON.stringify(answer);
  const middle = Math.floor(text.length / 2);
  update("another-session", "agent_message_chunk", "Unrelated reply.");
  update(sessionId, "agent_thought_chunk", "Unrelated reasoning.");
  update(sessionId, "agent_message_chunk", "Info: Disabled tools: bash, view");
  update(sessionId, "agent_message_chunk", 'Info: Unknown tool name in the tool allowlist: "pzn_model_text_only"');
  update(sessionId, "agent_message_chunk", text.slice(0, middle));
  update(sessionId, "agent_message_chunk", text.slice(middle));
  send({ id: prompt.id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  assert.equal(message.jsonrpc, "2.0");
  switch (message.method) {
    case "initialize":
      assert.equal(message.params.protocolVersion, 1);
      assert.deepEqual(message.params.clientCapabilities, {});
      send({ id: message.id, result: { protocolVersion: 1 } });
      break;
    case "session/new":
      assert.equal(realpathSync(message.params.cwd), process.cwd());
      assert.deepEqual(message.params.mcpServers, []);
      send({ id: message.id, result: { sessionId } });
      break;
    case "session/prompt":
      assert.equal(message.params.sessionId, sessionId);
      prompt = message;
      pending.add("permission").add("editor");
      send({ id: "permission", method: "session/request_permission", params: { sessionId } });
      send({ id: "editor", method: "fs/read_text_file", params: { sessionId, path: "example.txt" } });
      break;
    case undefined:
      assert.ok(pending.delete(message.id));
      if (message.id === "permission") assert.deepEqual(message.result, { outcome: { outcome: "cancelled" } });
      else assert.equal(message.error.code, -32601);
      if (!pending.size) respond();
      break;
    default:
      assert.fail("Unexpected ACP method");
  }
});
