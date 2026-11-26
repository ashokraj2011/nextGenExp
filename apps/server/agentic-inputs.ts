import { amountCentsMax, type InputField, type InputValues, type Journey } from "../../packages/contracts/agentic";
import { fundingOptionsSchema } from "../../packages/contracts/funding-workflow";

const exclusion = /\b(?:no\s+(?:promotions?|offers?|recommendations?|sales pitches)|(?:without|exclude|skip|avoid)\s+(?:any\s+)?(?:promotions?|offers?|recommendations?)|(?:don['’]t|do not)\s+(?:show|include|recommend)(?:\s+me)?\s+(?:any\s+)?(?:promotions?|offers?|recommendations?))\b/i;
export const excludesPromotions = (message: string) => exclusion.test(message);
export const resumesJourney = (message: string) => /^(?:please )?(?:continue|resume)(?: (?:where we (?:left off|stopped)|(?:my|the|that) (?:goal|journey|preview|plan)))?[.!?]*$/i.test(message.trim());
export const cancelsJourney = (message: string) => /^(?:please )?(?:stop|cancel|forget|never mind|nevermind)(?: (?:it|this|the|my|that))?(?: (?:plan|journey|transfer|preview|funding|deposit|goal))?[.!?]*$/i.test(message.trim());
export const pausesJourney = (message: string) => /^(?:pause|put (?:this|it) on hold)(?: (?:this|my|the) (?:plan|journey|goal|preview))?[.!?]*$/i.test(message.trim());

const wholeAmounts = /(?:\$\s*|\bUSD\s+)(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?!\d|[.,]\d)|\b(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s+(?:dollars?|USD)\b/gi;
export function explicitAmount(message: string) {
  const matches = Array.from(message.matchAll(wholeAmounts));
  if (matches.length !== 1 || /(?:-|minus\s*)\s*$/i.test(message.slice(0, matches[0].index))) return;
  const value = (matches[0][1] ?? matches[0][2]).replaceAll(",", "");
  const [dollars, fraction = ""] = value.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  if (Number.isSafeInteger(cents) && cents >= 0 && cents <= amountCentsMax) return cents;
}
const written = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export function explicitInputs(message: string): InputValues {
  const text = message.trim().toLowerCase();
  const values: InputValues = {};
  const amount = explicitAmount(text);
  if (amount !== undefined) {
    if (/\b(?:monthly|per month|each month|a month)\b/.test(text)) values.monthlyCents = amount;
    else values.amountCents = amount;
  }
  const time = text.match(/\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s*[- ]\s*(months?|years?)\b/);
  if (time) {
    const duration = (Number(time[1]) || written.indexOf(time[1])) * (time[2].startsWith("year") ? 12 : 1);
    if (duration > 0 && duration <= 120) values.months = duration;
  }
  const bank = /\b(?:linked bank|bank transfer|bank account)\b/.test(text);
  const cash = /\b(?:cash management|cash account|another account|account transfer)\b/.test(text);
  if (bank !== cash) values.methodId = bank ? "bank_transfer" : "account_transfer";
  return values;
}

export function isJourneyAnswer(message: string, journey: Journey) {
  const text = message.trim();
  const values = explicitInputs(text);
  if (journey.results.some(({ missing }) => missing?.includes("methodId")) && typeof values.methodId === "string"
    && /^(?:(?:please )?(?:use |from |choose |select )?(?:(?:my|the) )?)?(?:linked bank(?: account)?|bank transfer|bank account|cash management(?: account)?|cash account|another account|account transfer)[.!?]*$/i.test(text)) return true;
  if (!journey.plan.steps.some(({ capabilityId }) => capabilityId === "account.funding.preview")) return false;
  return typeof values.amountCents === "number" && /^(?:\$|USD\b|\d|(?:please )?(?:change|make|set|update|use)\b)/i.test(text)
    && !/\b(?:balance|retire|portfolio|address|house)\b/i.test(text);
}

export function fieldValueValid(field: InputField, value: unknown, options?: unknown) {
  if (value === undefined) return !field.required;
  if (field.type === "integer") return typeof value === "number" && Number.isInteger(value) && value >= field.min && value <= field.max;
  if (field.type === "text") return typeof value === "string" && value.trim().length > 0 && value.length <= field.maxLength && !/[\u0000-\u001f]/.test(value);
  const eligible = fundingOptionsSchema.safeParse(options);
  return eligible.success && eligible.data.methods.some(({ methodId }) => methodId === value);
}
