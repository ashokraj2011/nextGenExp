import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { ConversationView, TurnAccepted, TurnView } from "../packages/contracts/api";
import type { DisplayExperience } from "../packages/contracts/surface";
import type { Trace } from "../apps/web/api";

export const testProject = new URL("../", import.meta.url);
export async function testClient(base: string, existingCookie?: string) {
  const initial = await fetch(base + "/api/bootstrap", { headers: existingCookie ? { Cookie: existingCookie } : undefined });
  assert.equal(initial.status, 200);
  const cookie = existingCookie ?? initial.headers.get("set-cookie")!.split(";")[0];
  const response = (path: string, payload?: unknown, headers?: Record<string, string>) => fetch(base + path, {
    method: payload === undefined ? "GET" : "POST", headers: { Cookie: cookie, "Content-Type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  const request = async <T>(path: string, payload?: unknown, expected = 200) => {
    const result = await response(path, payload);
    const value = await result.json();
    assert.equal(result.status, expected, JSON.stringify(value));
    return value as T;
  };
  const conversation = (scenarioId = "normal", personaId = "demo-learner") => request<ConversationView>(
    "/api/conversations", { personaId, scenarioId }, 201,
  );
  const submit = (conversationId: string, message: string, clientRequestId = randomUUID()) => request<TurnAccepted>(
    "/api/conversations/" + conversationId + "/turns", { message, clientRequestId }, 202,
  );
  const turn = (id: string) => request<TurnView>("/api/turns/" + id);
  const trace = (id: string) => request<Trace>("/api/debug/turns/" + id);
  const wait = async (accepted: Pick<TurnAccepted, "turnId" | "eventsUrl">) => {
    const stream = await response(accepted.eventsUrl);
    assert.equal(stream.status, 200);
    const events = await stream.text();
    return { turn: await turn(accepted.turnId), events, trace: await trace(accepted.turnId) };
  };
  const ask = async (conversationId: string, message: string) => wait(await submit(conversationId, message));
  return { cookie, response, request, conversation, submit, turn, trace, ask, wait };
}

export function actionFor(experience: DisplayExperience, actionIndex = 0): ActionMessage {
  const { actionId, componentId } = experience.actions[actionIndex];
  return {
    version: "1.0",
    action: {
      name: "request_follow_up", context: { actionId }, surfaceId: experience.experienceId,
      sourceComponentId: componentId, timestamp: new Date().toISOString(),
    },
  };
}
