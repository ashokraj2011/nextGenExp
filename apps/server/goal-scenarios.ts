import {
  firstGoalContributionMonth, goalMonthAt, goalMonthIndex, goalProjectionMonths, goalSavingsProjectionSchema,
} from "../../packages/contracts/goal-progress";
import type { TurnRecord } from "./store";

export type GoalScenarioInvocation = { sourceTurnId: string; startMonth: string };

export function goalScenarioCard(turn?: TurnRecord) {
  if (turn?.public.status !== "completed") return;
  const block = turn.public.experience?.blocks.find((block) => block.component === "PznGoalProgress" && block.props.savingsOption);
  if (block?.component === "PznGoalProgress" && block.props.savingsOption) {
    return { goal: block.props.goal, option: block.props.savingsOption,
      firstMonth: firstGoalContributionMonth(block.props.goal, turn.public.createdAt) };
  }
}

const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const byName = new Map(months.flatMap((name, index) => [[name, index], [name.slice(0, 3), index]] as const));
const startRequest = /^(?:(?:what if|could|can|if) i |i (?:want to|could|can) )?start(?: saving| contributing)? (?:in|from) ([a-z]+)(?: (\d{4}))?[.!?]*$/i;

export function goalScenarioMonth(prompt: string, firstMonth: string) {
  const match = startRequest.exec(prompt.trim().replace(/\s+/g, " "));
  if (!match) return;
  const month = byName.get(match[1].toLowerCase());
  if (month === undefined) return;
  const first = goalMonthIndex(firstMonth);
  const year = match[2] ? Number(match[2]) : Math.floor(first / 12);
  const earliest = year * 12 + month;
  const requested = !match[2] && earliest < first ? earliest + 12 : earliest;
  return requested >= first && requested - first < goalProjectionMonths ? { month: goalMonthAt(requested) } : { month: null };
}

export function goalScenarioSource(source: TurnRecord | undefined, turn: TurnRecord) {
  if (!source || turn.scope.domainId !== "wealth" || source.scope.conversationId !== turn.scope.conversationId
    || source.scope.personaId !== turn.scope.personaId || source.scope.principalId !== turn.scope.principalId
    || source.ordinal >= turn.ordinal) return;
  return goalScenarioCard(source);
}
