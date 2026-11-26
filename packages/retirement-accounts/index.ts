import { z } from "zod";
import source from "../../fixtures/retirement-accounts.json";
import { retirementAccountSchema, retirementListIntent, type RetirementView } from "../contracts/retirement-accounts";

const records = z.record(z.array(retirementAccountSchema).max(12)).parse(source);
export function memberRetirementAccounts(mid: string) {
  return records[mid] ?? [];
}

export function readRetirementView(mid: string, intent: string, message: string, previous?: RetirementView): RetirementView {
  const records = memberRetirementAccounts(mid);
  const accounts = records.map(({ id, label }) => ({ id, label }));
  const list = { title: "Your retirement accounts", accounts, selected: null };
  if (intent === retirementListIntent || !accounts.length) return list;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const text = normalize(message);
  const identifier = message.match(/\bRET-\d+\b/i)?.[0].toUpperCase();
  const ending = text.match(/\bending (?:in )?(\d{4})\b/)?.[1];
  const labels = accounts.filter(({ label }) => text.includes(normalize(label)));
  const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];
  const ordinal = text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last|\d+(?:st|nd|rd|th))\b/)?.[1]
    ?? text.match(/\b(?:account|option|number) (\d{1,2})\b/)?.[1] ?? (/^\d{1,2}$/.test(text) ? text : undefined);
  const displayed = previous?.accounts ?? [];
  const index = ordinal === "last" ? displayed.length - 1 : ordinal && /^\d/.test(ordinal) ? parseInt(ordinal, 10) - 1 : ordinals.indexOf(ordinal ?? "");
  let id = identifier;
  if (!id) {
    if (ending) id = "RET-" + ending;
    else if (ordinal) id = displayed[index]?.id;
    else if (labels.length === 1) id = labels[0].id;
    else if (/\bother\b/.test(text)) {
      if (previous?.selected && displayed.length === 2) id = displayed.find((entry) => entry.id !== previous.selected!.id)?.id;
    } else if (!labels.length && !/\b(?:rollover|roth|traditional|401)\b/.test(text)) {
      id = previous?.selected?.id ?? (accounts.length === 1 ? accounts[0].id : undefined);
    }
  }
  const selected = records.find((a) => a.id === id);
  // Retain the last displayed order so another ordinal can follow a detail card.
  return selected ? { title: selected.label, accounts: displayed, selected } : list;
}
