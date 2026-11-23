import {
  componentOutputs, type CapabilityManifest, type ComponentKind, type Evidence, type ExperienceIR, type ExperienceProposal, type Journey,
} from "../contracts/agentic";
import { fundingOptionsSchema, fundingPreviewSchema } from "../contracts/funding-workflow";
import { goalProgressSchema } from "../contracts/goal-progress";
import { metricReadingSchema } from "../contracts/domain";
import { formatPortfolioAmount, portfolioSnapshotSchema } from "../contracts/portfolio";
import { capabilityForm, factSummary, savingsChart, savingsMetric, type DisplayBlock } from "../contracts/surface";
import { approvedContentSchema, addressResultSchema } from "../capabilities";
import { contributionSchema, projectionSchema } from "../capabilities/calculations";
import { contentCatalog } from "./content";
import { buildSurface, makeId, type IssuedAction } from "./compile";

const canBind = (component: ComponentKind, outputKind: Evidence["outputKind"]) => componentOutputs[component].includes(outputKind);

function fromContent(contentId: string) {
  const content = contentCatalog.entries.find((entry) => entry.contentId === contentId && entry.publicationStatus === "published");
  if (!content) return;
  return {
    variant: "expanded" as const, title: content.title, body: content.body, description: content.description,
    sources: [{ title: content.title, label: content.sourceLabel, version: content.version, ref: content.sourceRef }],
    disclosures: content.requiredDisclosures.map(({ text }) => text),
    ...(content.recommendation && { recommendation: true as const }),
  };
}

function blockFor(component: ComponentKind, value: unknown, exclusions: boolean): DisplayBlock | undefined {
  switch (component) {
    case "GoalProgress": {
      const card = fromContent("home_down_payment_progress");
      if (!card) return;
      const { variant, title, sources, disclosures } = card;
      return { component: "PznGoalProgress", props: { variant, title, sources, disclosures, goal: goalProgressSchema.parse(value) } };
    }
    case "Portfolio": return { component: "PznPortfolioSnapshot", props: portfolioSnapshotSchema.parse(value) };
    case "Balances": {
      const card = fromContent("balance_metric_template");
      const { observedAt, values } = metricReadingSchema.parse(value);
      if (!card) return;
      const { variant, title, sources, disclosures } = card;
      return { component: "PznMetricSummary", props: { variant, title, sources, disclosures, observedAt, values } };
    }
    case "Chart": return { component: savingsChart.name, props: projectionSchema.parse(value) };
    case "Metric": {
      const contribution = contributionSchema.safeParse(value);
      if (contribution.success) return { component: savingsMetric.name, props: contribution.data };
      const { cashCents } = portfolioSnapshotSchema.parse(value);
      return { component: factSummary.name, props: { title: "Available portfolio cash", body: "From your portfolio snapshot.", facts: [
        { label: "Cash", value: formatPortfolioAmount(cashCents) },
      ] } };
    }
    case "Content": {
      const { contentId } = approvedContentSchema.parse(value);
      const item = contentCatalog.entries.find((entry) => entry.contentId === contentId);
      if (exclusions && item?.kind === "promotion") return;
      const card = fromContent(contentId);
      return card && { component: "PznContentCard", props: card };
    }
    case "FundingOptions": return { component: "PznFundingOptions", props: fundingOptionsSchema.parse(value) };
    case "FundingPreview": return { component: "PznFundingPreview", props: fundingPreviewSchema.parse(value) };
    case "Summary":
      addressResultSchema.parse(value);
      return { component: factSummary.name, props: { title: "Address change prepared", body: "Review prepared. Your account address remains as recorded.", facts: [] } };
  }
}

type VerifiedStep = { manifest: CapabilityManifest; records: Evidence[]; status: Journey["results"][number]["status"]; reason?: string };
const submitLabel = (step: VerifiedStep) => {
  if (step.manifest.completionCriteria.includes("fundingPreview")) return "Preview funding";
  if (step.manifest.completionCriteria.includes("address")) return "Prepare address change";
  return "Recalculate";
};

export function compileAgenticExperience(
  journey: Journey, verified: ReadonlyMap<string, VerifiedStep>, proposal: ExperienceProposal | undefined, expiresAt: number, saved: boolean,
) {
  const issued: IssuedAction[] = [];
  const blocks: DisplayBlock[] = [];
  const sections: ExperienceIR["sections"] = [];
  const defaults = [...verified.entries()].flatMap(([stepId, step]) => {
    const parts = step.manifest.experience.allowedComponents.filter((component) => {
      if (component === "FundingOptions" && step.status === "completed") return false;
      if (component === "Form") return step.status === "waiting_input" || (step.status === "completed" && !step.manifest.completionCriteria.includes("address"));
      return step.records.some(({ outputKind }) => canBind(component, outputKind));
    });
    const unique = parts.filter((component) => component !== "Metric" || !parts.includes("Portfolio"));
    return unique.map((component) => ({ stepId, component }));
  });
  const seen = new Set<string>();
  const proposed = [...proposal?.sections ?? [], ...defaults];
  for (const { stepId, component } of proposed) {
    const step = verified.get(stepId);
    const key = stepId + ":" + component;
    if (!step || seen.has(key) || !step.manifest.experience.allowedComponents.includes(component)) continue;
    if (component === "Form") {
      if (!defaults.some((entry) => entry.stepId === stepId && entry.component === "Form")) continue;
      const options = fundingOptionsSchema.safeParse(step.records.find(({ outputKind }) => outputKind === "fundingOptions")?.payload);
      const fields = step.manifest.inputs.map((field) => ({
        field,
        value: journey.inputs[field.id] ?? (field.type === "integer" ? field.default : undefined),
        ...(field.type === "choice" && options.success && { choices: options.data.methods.map(({ methodId, label }) => ({ id: methodId, label })) }),
      }));
      if (!fields.length || fields.some(({ field, choices }) => field.type === "choice" && !choices?.length)) continue;
      const sign = (operation: "revise" | "save", label: string) => {
        const actionId = makeId("action");
        issued.push({
          actionId, componentId: "block_" + (blocks.length + 1), label, userMessage: label, followUpId: stepId,
          agentAction: { operation, journeyId: journey.id, revision: journey.revision,
            capability: step.manifest.id + "@" + step.manifest.version, fieldIds: fields.map(({ field }) => field.id) },
        });
        return actionId;
      };
      const label = submitLabel(step);
      const actionId = sign("revise", label);
      const saveActionId = step.manifest.completionCriteria.includes("projection") && step.status === "completed" ? sign("save", "Save savings plan") : undefined;
      blocks.push({ component: capabilityForm.name, props: {
        actionId, saveActionId, fields,
        title: step.manifest.completionCriteria.includes("contribution") ? "Savings timeframe" : step.manifest.title,
        submitLabel: label,
      } });
      sections.push({ stepId, component });
      seen.add(key);
      continue;
    }
    const proof = step.records.find(({ outputKind }) => canBind(component, outputKind));
    if (!proof || (component === "FundingOptions" && step.status === "completed") || sections.some(({ evidenceId }) => evidenceId === proof.evidenceId)) continue;
    const block = blockFor(component, proof.payload, journey.excludePromotions);
    if (block) {
      blocks.push(block);
      sections.push({ stepId, component, evidenceId: proof.evidenceId });
      seen.add(key);
    }
  }

  const incomplete = journey.plan.steps.flatMap(({ id, required }) => {
    const step = verified.get(id);
    if (!step || (!required && step.status !== "completed")) return [];
    if (step.status === "failed" || step.status === "blocked") return [{
      label: step.manifest.title,
      value: step.reason === "NOT_ELIGIBLE" ? "Unavailable for this account"
        : step.reason === "ACCOUNT_ALREADY_FUNDED" ? "A first deposit is already on file"
        : "Couldn’t complete this step. Try again to refresh.",
    }];
    return [];
  });
  if (incomplete.length) blocks.push({ component: factSummary.name, props: { title: "Step status", body: "Here’s what still needs attention.", facts: incomplete } });
  const fundingMissing = journey.results.find(({ missing }) => missing?.includes("methodId") || missing?.includes("amountCents"));
  const question = fundingMissing?.missing?.includes("methodId") ? "Which funding method would you like to preview?"
    : fundingMissing ? "How much would you like to deposit?" : null;
  const layout = proposal?.layout ?? "stack";
  const ir: ExperienceIR = { goalId: journey.goalId, revision: journey.revision, layout, sections };
  return {
    ir,
    result: buildSurface({
      status: question ? "clarify" : "ready", outcome: question ? "clarify" : "ready", question, layout, expiresAt,
      partial: incomplete.length > 0 && blocks.length > 1,
      intro: saved ? "Your savings plan was saved." : blocks.length ? "Here’s what I pulled together for you." : "I couldn’t verify a result for this request.",
    }, blocks, issued),
  };
}
