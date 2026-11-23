import { randomUUID } from "node:crypto";
import host from "../../fixtures/host.json";
import type { BalanceProof, IntroKey } from "../contracts/domain";
import { fundingPreviewWorkflow, type FundingPreview, type WorkflowRecommendation } from "../contracts/funding-workflow";
import type { GoalProgress } from "../contracts/goal-progress";
import { formatPortfolioAmount, type PortfolioSnapshot } from "../contracts/portfolio";
import type { RuleGlossary } from "../contracts/rule-glossary";
import {
  MAX_SURFACE_BYTES, PZN_CATALOG_ID, fundingPreview, portfolioSnapshot, ruleCreation, validatePznSurface,
  type DisplayBlock, type DisplayExperience, type RuleCreationProps,
} from "../contracts/surface";
import type { VerifiedExperience } from "./verify";

export const makeId = (prefix: string) => prefix + "_" + randomUUID().replaceAll("-", "");
export type IssuedAction = DisplayExperience["actions"][number] & {
  userMessage: string; followUpId: string; workflow?: WorkflowRecommendation;
};
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
  portfolio?: PortfolioSnapshot;
  goalProgress?: GoalProgress;
  workflow?: WorkflowRecommendation;
};

export function compileExperience(input: ExperienceInput): CompiledExperience {
  const intro = input.portfolio ? host.introCopy.summary
    : input.approved?.proposal.replyText?.trim() || host.introCopy[input.introKey];
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
          ...shared, title: "Compare balance definitions",
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
      case "PznGoalProgress": {
        if (!input.goalProgress) throw new Error("Verified goal progress is required");
        return { component: proposal.component, props: { ...shared, goal: input.goalProgress } };
      }
      case "PznContentCard": {
        if (primary.portfolioData === "cash") {
          if (!input.portfolio) throw new Error("Verified portfolio snapshot is required");
          const body = `You have ${formatPortfolioAmount(input.portfolio.cashCents)} in cash. ${primary.body}`;
          return { component: proposal.component, props: { ...shared, description: primary.description, body, recommendation: true } };
        }
        return { component: proposal.component, props: {
          ...shared, description: primary.description, body: primary.body, ...(primary.recommendation && { recommendation: true }),
        } };
      }
    }
  });
  const workflow = input.workflow && {
    followUpId: input.workflow.id, label: fundingPreviewWorkflow.label,
    userMessage: fundingPreviewWorkflow.label, workflow: input.workflow,
  };
  const issued = [...(workflow ? [workflow] : []), ...(input.approved?.followUps ?? [])].slice(0, 3).map((action, index) => ({
    ...action, actionId: makeId("action"), componentId: "follow_up_" + (index + 1),
  }));
  if (input.portfolio) blocks.unshift({ component: portfolioSnapshot.name, props: input.portfolio });
  return buildSurface({
    status: input.portfolio ? "ready" : input.status, outcome: input.portfolio ? "ready" : input.outcome,
    intro, question: input.portfolio ? null : input.question, partial: input.partial, expiresAt: input.expiresAt,
  }, blocks, issued);
}

export function compileFundingPreview(preview: FundingPreview, expiresAt: number): CompiledExperience {
  return buildSurface({
    status: "ready", outcome: "ready", intro: "Your funding preview is ready.",
    question: null, partial: false, expiresAt,
  }, [{ component: fundingPreview.name, props: preview }], []);
}

export function compileRuleCreation(props: RuleCreationProps & { glossary: RuleGlossary }, expiresAt: number): CompiledExperience {
  return buildSurface({
    status: "ready", outcome: "create_rule", intro: "Choose content and set a rule for when to show it.",
    question: null, partial: false, expiresAt,
  }, [{ component: ruleCreation.name, props }], []);
}

export function compileChatReply(text: string, outcome: "reply" | "no_match" | "eligible_empty", expiresAt: number): CompiledExperience {
  return buildSurface({
    status: outcome === "reply" ? "ready" : "no_match",
    outcome, intro: text, question: null, partial: false, expiresAt,
  }, [], []);
}

function buildSurface(
  displayFields: Pick<DisplayExperience, "status" | "outcome" | "intro" | "question" | "partial" | "expiresAt">,
  blocks: DisplayBlock[],
  issued: IssuedAction[],
): CompiledExperience {
  const experienceId = makeId("exp");
  const { intro, question, partial } = displayFields;
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
        children: nodes.map((node) => node.id), actionCount: actions.length, question, partial,
      }, ...nodes],
    },
  }, experienceId);
  const display: DisplayExperience = {
    ...displayFields, experienceId, messageId: makeId("msg"), blocks, actions,
    a2uiVersion: "1.0", messages: [message],
  };
  if (Buffer.byteLength(JSON.stringify(display)) > MAX_SURFACE_BYTES) throw new Error("Display payload exceeds limit");
  return { display, issued };
}
