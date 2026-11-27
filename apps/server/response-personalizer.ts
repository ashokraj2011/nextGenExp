import type { CompiledExperience } from "../../packages/experience/compile";
import type { DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import { formatUnsupportedReply } from "../../packages/contracts/routing-intents";
import type { StoredCustomerProfile } from "../../packages/contracts/customer-360";

export type ResponseTone =
  | "job_loss"
  | "hardship"
  | "frustration"
  | "milestone"
  | "gratitude"
  | "first_turn"
  | "follow_up";

const jobLossRegex = /\b(lost\s+my\s+job|losing\s+my\s+job|loose\s+my\s+job|laid\s*off|lay\s*off|got\s+fired|been\s+fired|let\s+go\s+from|furloughed|unemployed|lost\s+employment|job\s+loss)\b/i;
const hardshipRegex = /\b(medical\s+emergency|hospital(?:ized)?|passed\s+away|bereavement|divorce|family\s+emergency|financial\s+(?:trouble|crisis|hardship)|struggling\s+to\s+pay|urgent\s+bills?|really\s+stressed|overwhelmed|anxious\s+about\s+money|worried\s+about\s+(?:money|bills|losing))\b/i;
const frustrationRegex = /\b(where\s+is\s+(?:the|my)|that(?:'s|\s+is)\s+not\s+what\s+i|you\s+didn'?t\s+(?:show|give|include)|still\s+missing|missed\s+the|not\s+a\s+(?:pie|bar|bubble|donut)\s*chart|why\s+didn'?t\s+you)\b/i;
const milestoneRegex = /\b(buy(?:ing)?\s+a\s+(?:house|home)|new\s+baby|expecting\s+a\s+baby|got\s+married|getting\s+married|got\s+a\s+(?:promotion|raise|bonus)|set\s*up\s+another\s+goal|create\s+a\s+new\s+goal)\b/i;
const gratitudeRegex = /^(?:thanks|thank\s+you|thx|appreciate\s+it)\b/i;

export function firstNameOf(displayName?: string | null): string | undefined {
  const clean = displayName?.trim();
  if (!clean) return undefined;
  const first = clean.split(/\s+/)[0];
  return first && first.length <= 28 ? first : undefined;
}

export function detectTone(userMessage: string, ordinal: number): ResponseTone {
  const clean = userMessage.trim();
  if (jobLossRegex.test(clean)) return "job_loss";
  if (hardshipRegex.test(clean)) return "hardship";
  if (frustrationRegex.test(clean)) return "frustration";
  if (milestoneRegex.test(clean)) return "milestone";
  if (gratitudeRegex.test(clean)) return "gratitude";
  return ordinal <= 1 ? "first_turn" : "follow_up";
}

function lowercaseLead(text: string): string {
  if (!text) return text;
  // Keep proper nouns / acronyms / "I" capitalized
  if (/^(?:I\b|I['’]|AAPL|MSFT|NVDA|INTC|BA|PFE|IRA|401|CEP|TS\b|CCRE\b|US\b|USD\b)/.test(text)) return text;
  if (/^[A-Z]{2,}/.test(text)) return text;
  return text[0]!.toLowerCase() + text.slice(1);
}

const GENERIC_INTROS = new Set([
  "Here’s your summary.",
  "Here's your summary.",
  "Here’s an overview.",
  "Here's an overview.",
  "Here’s a comparison.",
  "Here's a comparison.",
  "Here are the steps.",
  "Here are your funding options.",
  "Here’s your recommended next step.",
  "Here's your recommended next step.",
]);

export function personalizeIntro(
  rawIntro: string,
  opts: {
    firstName?: string;
    userMessage: string;
    ordinal: number;
    outcome: string;
    hasBlocks: boolean;
  },
): string {
  const intro = rawIntro.trim();
  if (!intro || !opts.firstName) return intro;

  // Preserve exact contract confirmations and model-authored plain replies tested verbatim
  if (intro === "Your savings plan was saved.") return intro;
  if (opts.outcome === "eligible_empty" || opts.outcome === "reply") return intro;
  if (opts.outcome === "no_match" && intro === formatUnsupportedReply(opts.userMessage)) return intro;

  const name = opts.firstName;
  const lower = intro.toLowerCase();
  const alreadyHasName = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(intro);
  const alreadyEmpathetic = /\b(sorry to hear|sorry you|congratulations|good catch|hi\s+\w|thanks for asking|you're welcome|you’re welcome)\b/i.test(lower);
  const tone = detectTone(opts.userMessage, opts.ordinal);

  // Empathy cues ALWAYS apply if not already acknowledged, even when name is present
  if (tone === "job_loss" && !/\bsorry\b/i.test(lower)) {
    return `I’m really sorry to hear you’re going through a job loss, ${name}. ${intro}`;
  }
  if (tone === "hardship" && !/\bsorry\b/i.test(lower)) {
    return `I’m really sorry you’re dealing with that, ${name}. ${intro}`;
  }
  if (tone === "frustration" && !alreadyEmpathetic) {
    return `Good catch, ${name} — sorry for missing that earlier. ${intro}`;
  }
  if (alreadyHasName || alreadyEmpathetic) {
    return intro;
  }

  if (tone === "milestone") {
    return `That’s an exciting milestone, ${name} — ${lowercaseLead(intro)}`;
  }
  if (tone === "gratitude") {
    return `You’re very welcome, ${name}! ${intro}`;
  }

  // Upgrade robotic generic intros ("Here's your summary.") cleanly
  if (GENERIC_INTROS.has(intro)) {
    if (tone === "first_turn") {
      return `Hi ${name}, ${lowercaseLead(intro)}`;
    }
    const followUpLead = opts.ordinal % 2 === 0
      ? `Thanks for asking, ${name} — `
      : `Here you go, ${name} — `;
    return `${followUpLead}${lowercaseLead(intro)}`;
  }

  if (tone === "first_turn") {
    return `Hi ${name}, ${lowercaseLead(intro)}`;
  }
  return `Thanks for asking, ${name} — ${lowercaseLead(intro)}`;
}

export function applyPersonalization(
  compiled: CompiledExperience,
  opts: { firstName?: string; userMessage: string; ordinal: number },
): CompiledExperience {
  const nextIntro = personalizeIntro(compiled.display.intro, {
    firstName: opts.firstName,
    userMessage: opts.userMessage,
    ordinal: opts.ordinal,
    outcome: compiled.display.outcome,
    hasBlocks: compiled.display.blocks.length > 0,
  });
  if (nextIntro === compiled.display.intro) return compiled;

  const [firstMsg] = compiled.display.messages;
  const updatedFirst = firstMsg.createSurface
    ? {
        ...firstMsg,
        createSurface: {
          ...firstMsg.createSurface,
          dataModel: {
            ...firstMsg.createSurface.dataModel,
            intro: nextIntro,
          },
        },
      }
    : firstMsg;
  return {
    ...compiled,
    display: {
      ...compiled.display,
      intro: nextIntro,
      messages: [updatedFirst],
    },
  };
}

/**
 * Matches standalone urgent life-event hardship prompts (e.g. "I just lost my job, what should I do?",
 * "I was laid off today", "medical emergency, need cash") — deliberately excludes retirement-age
 * clarifications ("i am going to loose my job" after retirement prompts) and "looking for a new job".
 */
export function isStandaloneHardshipPrompt(prompt: string, hasRetirementHistory: boolean): boolean {
  const clean = prompt.trim();
  if (!clean) return false;
  if (/\b(?:find|look(?:ing)?\s+for)\s+(?:a\s+)?new\s+job\b|\bjob\s+search\b/i.test(clean)) return false;
  if (hasRetirementHistory && jobLossRegex.test(clean)) return false;
  if (/\b(i\s+just\s+lost\s+my\s+job|i\s+lost\s+my\s+job|i\s+was\s+laid\s*off|got\s+laid\s*off|got\s+fired|lost\s+my\s+job\b.*\b(what|help|do|cash|money|plan|options)|medical\s+emergency|family\s+emergency|financial\s+crisis)\b/i.test(clean)) {
    return true;
  }
  return false;
}

export function buildHardshipSupportCanvas(
  prompt: string,
  profile: StoredCustomerProfile | undefined,
): { intro: string; canvas: DynamicCanvasProps } {
  const name = firstNameOf(profile?.displayName) ?? "there";
  const isJobLoss = jobLossRegex.test(prompt);
  const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
  const cashCents = profile?.cashCents ?? 0;
  const availCents = profile?.availableBalanceCents ?? cashCents;
  const totalCents = (profile?.cashCents ?? 0) + (profile?.equityCents ?? 0) + (profile?.fixedIncomeCents ?? 0);
  const estMonthlyExpensesCents = 450_000; // $4,500 illustrative baseline
  const runwayMonths = cashCents > 0 ? Math.max(0.5, Math.round((cashCents / estMonthlyExpensesCents) * 10) / 10) : 0;

  const intro = isJobLoss
    ? `I’m really sorry to hear about losing your job, ${name}. Take a breath — let’s focus on protecting your immediate cash cushion and practical next steps together.`
    : `I’m really sorry you’re going through a difficult time, ${name}. Let’s look at your immediate liquid cash and steady next steps so you have clarity right now.`;

  return {
    intro,
    canvas: {
      title: isJobLoss ? "Job-Loss Financial Stability & Cash Runway" : "Emergency Liquidity & Stability Plan",
      badge: "Life Event Support",
      subtitle: `${profile?.displayName ?? "Customer"} · Grounded in live Customer 360 balances`,
      generatedBy: "synthesizer",
      dataSource: "Customer 360 Balances · Life-Event Guidance",
      prompt: prompt.slice(0, 600),
      nodes: [
        {
          type: "metrics",
          items: [
            { label: "Liquid Cash", value: usd(cashCents), delta: "Immediately accessible" },
            { label: "Available Balance", value: usd(availCents) },
            { label: "Total Portfolio", value: usd(totalCents) },
            { label: "Est. Cash Runway", value: `~${runwayMonths} mo`, delta: "At $4.5k/mo baseline" },
          ],
        },
        {
          type: "callout",
          tone: "highlight",
          title: "Priority #1: Preserve Liquidity Before Selling Long-Term Assets",
          body: `You currently have ${usd(cashCents)} in liquid cash (${usd(availCents)} available). Avoid rushing to liquidate long-term investments before reviewing severance, unemployment benefits, and monthly essential expenses.`,
        },
        {
          type: "checklist",
          title: isJobLoss ? "First-30-Days Financial Checklist" : "Immediate Stability Checklist",
          items: isJobLoss
            ? [
                "Pause non-essential recurring investment transfers to preserve liquid cash.",
                "Confirm severance payout timing, unused PTO payout, and state unemployment eligibility.",
                "Review health coverage options (COBRA vs. marketplace or spouse plan) within the 60-day window.",
                "Check 401(k) rollover or leave-in-place options — avoid early withdrawals that trigger taxes/penalties.",
                "Map essential monthly expenses against your current cash buffer.",
              ]
            : [
                "Verify immediately available cash before tapping invested holdings.",
                "Pause discretionary automatic contributions while expenses stabilize.",
                "Review whether any near-term goal timelines should be temporarily adjusted.",
                "Speak with a live advisor if you need a tailored liquidity or withdrawal plan.",
              ],
        },
      ],
      disclaimer: "Balances reflect live Customer 360 records. Runway estimate is illustrative; speak with a licensed advisor for personalized tax or benefits advice.",
    },
  };
}
