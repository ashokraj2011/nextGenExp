import assert from "node:assert/strict";
import { operatorHeader } from "./operator-fixture";
import { connectChat } from "../apps/harness/client";
import type { ApprovalRecord, PublicationReview } from "../packages/contracts/approval";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { DisplayExperience } from "../packages/contracts/surface";

export const testProject = new URL("../", import.meta.url);
export async function testClient(base: string, existingCookie?: string, role: "operator" | "customer" = "operator") {
  const client = await connectChat(base, existingCookie, role === "operator" ? operatorHeader() : undefined);
  // For tests whose subject is what happens after an authoring change goes live.
  async function publish<T>(path: string, payload: unknown, headers?: Record<string, string>) {
    const review = await client.request<PublicationReview>(path, payload, 202, headers);
    assert.equal(review.approval.status, "pending");
    const outcome = await client.request<{ approval: ApprovalRecord; execution: { value?: T } }>(
      "/api/approvals/" + review.approval.id + "/decide", { decision: "approve" }, 200, headers,
    );
    assert.equal(outcome.approval.status, "executed");
    return (review.approval.targetKind === "task_publish" ? outcome.execution : outcome.execution.value) as T;
  }
  return { ...client, publish };
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
