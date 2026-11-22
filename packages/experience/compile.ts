import { randomUUID } from "node:crypto";
import host from "../../fixtures/host.json";
import type { BalanceProof, IntroKey } from "../contracts/domain";
import {
  MAX_SURFACE_BYTES, PZN_CATALOG_ID, validatePznSurface, type DisplayBlock, type DisplayExperience,
} from "../contracts/surface";
import type { VerifiedExperience } from "./verify";

export const makeId = (prefix: string) => prefix + "_" + randomUUID().replaceAll("-", "");
export type IssuedAction = DisplayExperience["actions"][number] & { userMessage: string; followUpId: string };
export type CompiledExperience = { display: DisplayExperience; issued: IssuedAction[] };
type ExperienceInput = {
  status: DisplayExperience["status"];
  outcome: DisplayExperience["outcome"];
  introKey: IntroKey;
  question: string | null;
  partial: boolean;
  expiresAt: number;
  approved?: VerifiedExperience;
  proof?: BalanceProof | null;
};

export function compileExperience(input: ExperienceInput): CompiledExperience {
  const experienceId = makeId("exp");
  const intro = input.outcome === "eligible_empty"
    ? "There is no eligible demo content available for this request."
    : host.introCopy[input.introKey];
  const blocks: DisplayBlock[] = (input.approved?.blocks ?? []).map(({ proposal, content }) => {
    const primary = content[0];
    const shared = {
      variant: proposal.variant,
      title: primary.title,
      sources: content.map((entry) => ({ title: entry.title, label: entry.sourceLabel, version: entry.version, ref: entry.sourceRef })),
      disclosures: [...new Set(content.flatMap((entry) => entry.requiredDisclosures.map((item) => item.text)))],
    };
    switch (proposal.component) {
      case "PznComparison":
        return { component: proposal.component, props: {
          ...shared, title: "Compare demo definitions",
          columns: content.map((entry) => ({ title: entry.title, fields: entry.comparisonFields })),
        } };
      case "PznStepList":
        return { component: proposal.component, props: { ...shared, body: primary.body, steps: primary.steps } };
      case "PznMetricSummary": {
        if (!input.proof || !primary.metricSpec) throw new Error("Verified balance proof is required");
        const proof = input.proof;
        return { component: proposal.component, props: {
          ...shared, observedAt: proof.observedAt,
          values: primary.metricSpec.metricKeys.map((key) => {
            const value = proof.values.find((item) => item.metricKey === key);
            if (!value) throw new Error("Verified balance value is missing");
            return value;
          }),
        } };
      }
      case "PznContentCard":
        return { component: proposal.component, props: { ...shared, description: primary.description, body: primary.body } };
    }
  });
  const issued = (input.approved?.followUps ?? []).map((followUp, index) => ({
    ...followUp, actionId: makeId("action"), componentId: "follow_up_" + (index + 1),
  }));
  const actions = issued.map(({ actionId, componentId, label }) => ({ actionId, componentId, label }));
  const nodes = [
    ...blocks.map((block, index) => ({ id: "block_" + (index + 1), component: block.component, ...block.props })),
    ...actions.map(({ actionId, componentId, label }) => ({ id: componentId, component: "PznFollowUp", actionId, label })),
  ];
  const message = validatePznSurface({
    version: "1.0",
    createSurface: {
      surfaceId: experienceId, catalogId: PZN_CATALOG_ID, dataModel: { intro },
      components: [{
        id: "root", component: "PznExperience", intro: { "@path": "/intro" },
        children: nodes.map((node) => node.id), actionCount: actions.length, question: input.question, partial: input.partial,
      }, ...nodes],
    },
  }, experienceId);
  const display: DisplayExperience = {
    experienceId, messageId: makeId("msg"), status: input.status, outcome: input.outcome,
    intro, question: input.question, partial: input.partial, blocks, actions,
    expiresAt: input.expiresAt, a2uiVersion: "1.0", messages: [message],
  };
  if (Buffer.byteLength(JSON.stringify(display)) > MAX_SURFACE_BYTES) throw new Error("Display payload exceeds limit");
  return { display, issued };
}
