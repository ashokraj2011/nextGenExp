import type { DealRecord } from "../../packages/contracts/sales";
import type { IncidentRecord } from "../../packages/contracts/ops";

import type { DisplayBlock } from "../../packages/contracts/surface";

export function displayedRecordChoices(blocks: DisplayBlock[] = []) {
  const accounts = blocks.find((block) => block.component === "PznRetirementAccounts");
  if (accounts) return accounts.props.selected ? [] : accounts.props.accounts;
  const canvas = blocks.find((block) => block.component === "PznDynamicCanvas");
  return canvas?.props.choices?.filter(({ id }) => /^(DEAL|INC)-[\w-]+$/i.test(id)) ?? [];
}

const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];
export function recordChoiceIndex(message: string, count: number) {
  if (!count) return;
  const match = /^(?:(?:please |can you |could you )?(?:show(?: me)?|open|select|choose|view|take|who owns)\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last|(?:number\s+|#)?\d+(?:st|nd|rd|th)?)(?:\s+(?:one|item|option|deal|incident|record))?[.?!]?$/i.exec(message.trim());
  if (!match) return;
  const word = match[1].toLowerCase();
  if (word === "last") return count - 1;
  const index = ordinals.indexOf(word);
  return index >= 0 ? index : Number(word.match(/\d+/)?.[0]) - 1;
}

type NamedRecord = { id: string; label: string };
function namedRecords<T extends NamedRecord>(prompt: string, records: T[], prefix: "DEAL" | "INC"): T[] | undefined {
  const ids = prompt.toUpperCase().match(new RegExp("\\b" + prefix + "-[A-Z0-9]+\\b", "g"));
  if (ids) {
    const matches = records.filter((row) => ids.includes(row.id.toUpperCase()));
    return matches.length === new Set(ids).size ? matches : [];
  }
  const words = new Set(prompt.toLowerCase().match(/[a-z0-9]+/g));
  const matches = records.filter((r) => r.label.toLowerCase().split(/\W+/).some((w) =>
    w.length >= 4 && !["service", "platform", "corp", "production", "global", "gateway"].includes(w) && words.has(w)));
  return matches.length ? matches : undefined;
}

export function matchingDeals(prompt: string, deals: DealRecord[]) {
  return namedRecords(prompt, deals.map((d) => ({ ...d, label: d.accountName })), "DEAL")
    ?? (/\bpending (?:discount|pricing exception)\b/i.test(prompt) ? deals.filter((d) => d.discountStatus === "pending") : deals);
}

export function matchingIncidents(prompt: string, incidents: IncidentRecord[]) {
  const named = namedRecords(prompt, incidents.map((i) => ({ ...i, label: i.service })), "INC");
  if (named) return named;
  const severity = prompt.toUpperCase().match(/\bP[1-4]\b/)?.[0];
  return incidents.filter((i) => (!severity || i.severity === severity) && (!/\brollback\b/i.test(prompt) || i.rollbackStatus === "pending"));
}

export function recordPrompt(message: string, previousId: string | undefined, deals: DealRecord[], incidents: IncidentRecord[]) {
  if (/\b(?:deal|inc)-[a-z0-9]+\b/i.test(message)) return message;
  const dealsByName = namedRecords(message, deals.map((d) => ({ id: d.id, label: d.accountName })), "DEAL");
  const incidentsByName = namedRecords(message, incidents.map((i) => ({ id: i.id, label: i.service })), "INC");
  const names = [...(dealsByName ?? []), ...(incidentsByName ?? [])];
  if (names.length) return message + " (" + names.map((r) => r.id).join(", ") + ")";
  if (previousId && /^(?:who (?:owns|is assigned to|is responsible for) (?:it|this|that)|when did (?:it|this|that) start|what(?:'s| is) (?:blocking|next|the status)|what (?:changed|about (?:it|this|that))|(?:show|give) me (?:the |a )?(?:summary|timeline|status)|(?:when |(?:tell|notify|alert) me when ).*\b(?:quote|rollback)\b|(?:and )?(?:this|that) (?:deal|incident))\b/i.test(message.trim())
      && !/\b(balance|portfolio|savings|retirement|order)\b/i.test(message)) return message + " (" + previousId + ")";
  return message;
}
