import type { ContentEntry } from "../contracts/domain";
import { retirementListIntent, type RetirementView } from "../contracts/retirement-accounts";
import type { DisplayBlock } from "../contracts/surface";
import { buildSurface, makeId, type CompiledExperience } from "./compile";

export function compileRetirementView(view: RetirementView, intent: string, expiresAt: number, options: {
  composed?: CompiledExperience; reminder?: ContentEntry; recommendationsUnavailable?: boolean; steps?: boolean;
} = {}) {
  const { selected } = view;
  const blocks: DisplayBlock[] = [{ component: "PznRetirementAccounts", props: view }];
  const issued = [...(options.composed?.issued ?? [])];
  if (options.composed) blocks.push(...options.composed.display.blocks);
  const { reminder } = options;
  if (selected && selected.beneficiary === null && reminder && blocks.length === 1) {
    const shared = { title: reminder.title, variant: "expanded" as const,
      sources: [{ title: reminder.title, label: reminder.sourceLabel, version: reminder.version, ref: reminder.sourceRef }],
      disclosures: reminder.requiredDisclosures.map(({ text }) => text) };
    blocks.push(options.steps ? { component: "PznStepList", props: { ...shared, body: reminder.body, steps: reminder.steps } }
      : { component: "PznContentCard", props: { ...shared, body: reminder.body, description: reminder.description, recommendation: true } });
    const follow = reminder.followUps[0];
    if (follow && !options.steps && !issued.length) issued.push({ ...follow, actionId: makeId("action"), componentId: "follow_up_1" });
  }
  const intro = selected ? `Here’s the beneficiary record for your ${selected.label} ending in ${selected.id.slice(-4)}.`
    : !view.accounts.length ? "You have no retirement accounts on file."
    : intent === retirementListIntent ? "Choose an account to review its beneficiary." : "Which retirement account would you like to check?";
  return buildSurface({
    status: "ready", outcome: "ready", intro: intro + (options.recommendationsUnavailable ? " I couldn’t check suggested next steps just now." : ""),
    question: null, partial: Boolean(options.recommendationsUnavailable), expiresAt,
  }, blocks, issued.map((action) => selected && action.followUpId === "fu_beneficiary_steps"
    ? { ...action, userMessage: `Show me the steps to update the beneficiary for ${selected.label} ending in ${selected.id.slice(-4)}.` } : action));
}
