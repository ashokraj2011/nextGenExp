import { operatorHeader } from "./operator-fixture";
import { connectChat } from "../apps/harness/client";
import type { ActionMessage } from "@a2ui/web_core/v1_0";
import type { DisplayExperience } from "../packages/contracts/surface";

export const testProject = new URL("../", import.meta.url);
export function testClient(base: string, existingCookie?: string, role: "operator" | "customer" = "operator") {
  return connectChat(base, existingCookie, role === "operator" ? operatorHeader() : undefined);
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
