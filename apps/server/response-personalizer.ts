import type { CompiledExperience } from "../../packages/experience/compile";
import type { DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import { formatUnsupportedReply } from "../../packages/contracts/routing-intents";
import type { StoredCustomerProfile } from "../../packages/contracts/customer-360";
import {
  emotionalAssessmentSchema,
  empathyAssessToolRef,
  type EmotionalAssessment,
  type EmotionalLifeEvent,
  type EmotionalSentiment,
} from "../../packages/contracts/empathy";

export type ResponseTone =
  | "job_loss"
  | "hardship"
  | "frustration"
  | "milestone"
  | "gratitude"
  | "first_turn"
  | "follow_up";

const jobSearchGuard = /\b(?:find|look(?:ing)?\s+for)\s+(?:a\s+)?new\s+job\b|\bjob\s+search\b/i;
const jobLossRegex = /\b(lost\s+my\s+job|losing\s+my\s+job|loose\s+my\s+job|laid\s*off|lay\s*off|layoffs?|got\s+fired|been\s+fired|let\s+go\s+from|furloughed|unemployed|lost\s+employment|job\s+loss|company\s+(?:is\s+)?(?:downsizing|restructuring)|lost\s+(?:my|our)\s+income)\b/i;
const medicalHardshipRegex = /\b(medical\s+emergency|hospital(?:ized)?|in\s+the\s+(?:icu|er|hospital)|cancer\s+diagnosis|surgery\s+bills?|serious\s+illness|medical\s+bills?)\b/i;
const bereavementRegex = /\b(passed\s+away|bereavement|funeral|lost\s+my\s+(?:mom|mother|dad|father|spouse|husband|wife|partner|child|son|daughter|parent)|death\s+in\s+the\s+family)\b/i;
const familyCrisisRegex = /\b(divorce|family\s+emergency|financial\s+(?:trouble|crisis|hardship)|struggling\s+to\s+pay|urgent\s+bills?|really\s+stressed|overwhelmed|anxious\s+about\s+money|worried\s+about\s+(?:money|bills|losing)|can'?t\s+pay\s+(?:rent|mortgage|bills)|hardship)\b/i;
const hardshipRegex = new RegExp(
  `${medicalHardshipRegex.source}|${bereavementRegex.source}|${familyCrisisRegex.source}`,
  "i",
);
const frustrationRegex = /\b(where\s+is\s+(?:the|my)|that(?:'s|\s+is)\s+not\s+what\s+i|you\s+didn'?t\s+(?:show|give|include)|still\s+missing|missed\s+the|not\s+a\s+(?:pie|bar|bubble|donut)\s*chart|why\s+didn'?t\s+you)\b/i;
const homePurchaseRegex = /\b(buy(?:ing)?\s+a\s+(?:house|home)|home\s+purchase|down\s+payment\s+for\s+(?:a|our|my)\s+(?:house|home)|closing\s+on\s+(?:a|our|my)\s+(?:house|home))\b/i;
const newFamilyRegex = /\b(new\s+baby|expecting\s+a\s+baby|expecting\s+(?:twins|our\s+first\s+child)|had\s+a\s+baby|got\s+married|getting\s+married|wedding\s+coming\s+up)\b/i;
const careerMilestoneRegex = /\b(got\s+a\s+(?:promotion|raise|bonus)|new\s+job\s+offer|promoted\s+at\s+work)\b/i;
const milestoneRegex = /\b(buy(?:ing)?\s+a\s+(?:house|home)|new\s+baby|expecting\s+a\s+baby|got\s+married|getting\s+married|got\s+a\s+(?:promotion|raise|bonus)|set\s*up\s+another\s+goal|create\s+a\s+new\s+goal)\b/i;
const gratitudeRegex = /^(?:thanks|thank\s+you|thx|appreciate\s+it)\b/i;

// Customer 360 advisor notes cues
const notesJobLossRegex = /\b(job\s+loss|laid\s*off|layoff|layoffs|restructuring|downsizing|furlough|unemployed|between\s+jobs|severance)\b/i;
const notesMedicalRegex = /\b(medical\s+(?:emergency|hardship|leave|bills?)|hospital(?:ized)?|health\s+crisis|illness)\b/i;
const notesBereavementRegex = /\b(bereavement|passed\s+away|widowed|loss\s+of\s+(?:spouse|parent|family))\b/i;
const notesHardshipRegex = /\b(hardship|financial\s+(?:crisis|stress|strain)|suppress\s+promo|pause\s+promo|prioritize\s+liquidity|cash\s+runway|urgent\s+bills?|divorce)\b/i;
const notesNewFamilyRegex = /\b(new\s+baby|expecting\s+(?:a\s+)?baby|newborn|recently\s+married|upcoming\s+wedding)\b/i;
const notesHomePurchaseRegex = /\b(actively\s+house\s+hunting|buying\s+a\s+home|closing\s+on\s+a\s+home|home\s+purchase\s+imminent)\b/i;

// Purely mechanical commands that don't need an extra LLM call when heuristics + C360 notes are neutral
const mechanicalWealthQuery = /^(?:show|view|check|list|get|what(?:'s|\s+is)|how\s+much|compare|buy|sell|simulate|summarize)\b/i;

export function firstNameOf(displayName?: string | null): string | undefined {
  const clean = displayName?.trim();
  if (!clean) return undefined;
  const first = clean.split(/\s+/)[0];
  return first && first.length <= 28 ? first : undefined;
}

export function detectTone(userMessage: string, ordinal: number): ResponseTone {
  const clean = userMessage.trim();
  if (!jobSearchGuard.test(clean) && jobLossRegex.test(clean)) return "job_loss";
  if (hardshipRegex.test(clean)) return "hardship";
  if (frustrationRegex.test(clean)) return "frustration";
  if (milestoneRegex.test(clean)) return "milestone";
  if (gratitudeRegex.test(clean)) return "gratitude";
  return ordinal <= 1 ? "first_turn" : "follow_up";
}

function detectFromCustomerNotes(
  customerNotes: string | undefined,
  firstName: string | undefined,
): EmotionalAssessment | null {
  const notes = customerNotes?.trim();
  if (!notes) return null;
  const who = firstName ? `${firstName}` : "there";

  if (notesJobLossRegex.test(notes)) {
    return {
      sentiment: "concerned",
      lifeEvent: "job_loss",
      suppressPromotions: true,
      empathyLead: `Hi ${who} — keeping your recent job transition in mind, I’m focusing on your liquid cash and stability first.`,
      reason: "Customer 360 notes indicate a recent job loss or company restructuring; promotional offers suppressed.",
      source: "customer360_notes",
      fromCurrentMessage: false,
      toolRef: empathyAssessToolRef,
    };
  }
  if (notesBereavementRegex.test(notes)) {
    return {
      sentiment: "concerned",
      lifeEvent: "bereavement",
      suppressPromotions: true,
      empathyLead: `Hi ${who} — keeping your family in mind, I’ll keep this clear and straightforward for you.`,
      reason: "Customer 360 notes indicate recent bereavement; promotional offers suppressed.",
      source: "customer360_notes",
      fromCurrentMessage: false,
      toolRef: empathyAssessToolRef,
    };
  }
  if (notesMedicalRegex.test(notes)) {
    return {
      sentiment: "concerned",
      lifeEvent: "medical_hardship",
      suppressPromotions: true,
      empathyLead: `Hi ${who} — keeping your recent medical situation in mind, I’ll keep the focus on liquidity and essentials.`,
      reason: "Customer 360 notes indicate medical hardship; promotional offers suppressed.",
      source: "customer360_notes",
      fromCurrentMessage: false,
      toolRef: empathyAssessToolRef,
    };
  }
  if (notesHardshipRegex.test(notes)) {
    return {
      sentiment: "concerned",
      lifeEvent: "family_crisis",
      suppressPromotions: true,
      empathyLead: `Hi ${who} — keeping your current situation in mind, let’s keep the focus on liquidity and practical next steps.`,
      reason: "Customer 360 notes indicate active hardship or liquidity priority; promotional offers suppressed.",
      source: "customer360_notes",
      fromCurrentMessage: false,
      toolRef: empathyAssessToolRef,
    };
  }
  if (notesNewFamilyRegex.test(notes)) {
    return {
      sentiment: "celebratory",
      lifeEvent: "new_family",
      suppressPromotions: false,
      empathyLead: `Hi ${who} — congratulations again on the exciting family milestone!`,
      reason: "Customer 360 notes indicate a positive family milestone.",
      source: "customer360_notes",
      fromCurrentMessage: false,
      toolRef: empathyAssessToolRef,
    };
  }
  if (notesHomePurchaseRegex.test(notes)) {
    return {
      sentiment: "celebratory",
      lifeEvent: "home_purchase",
      suppressPromotions: false,
      empathyLead: `Hi ${who} — keeping your upcoming home purchase in mind, here’s where things stand.`,
      reason: "Customer 360 notes indicate an active home purchase milestone.",
      source: "customer360_notes",
      fromCurrentMessage: false,
      toolRef: empathyAssessToolRef,
    };
  }
  return null;
}

function detectHeuristicFromMessage(
  userMessage: string,
  firstName: string | undefined,
  hasRetirementHistory: boolean,
): EmotionalAssessment | null {
  const clean = userMessage.trim();
  const who = firstName ?? "there";

  if (!jobSearchGuard.test(clean) && jobLossRegex.test(clean)) {
    return {
      sentiment: "distressed",
      lifeEvent: "job_loss",
      suppressPromotions: true,
      empathyLead: `I’m really sorry to hear you’re going through a job loss, ${who}.`,
      customerNoteToSave: hasRetirementHistory
        ? "Mentioned potential job transition during retirement planning — prioritize liquidity and pause promotional offers."
        : "Shared recent job loss — prioritize liquid cash runway and pause promotional offers.",
      reason: "Customer shared a job loss or layoff in the current message; suppressing promotional offers.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  if (bereavementRegex.test(clean)) {
    return {
      sentiment: "distressed",
      lifeEvent: "bereavement",
      suppressPromotions: true,
      empathyLead: `I’m so sorry for your loss, ${who}. Please take all the time you need — we’ll take this one steady step at a time.`,
      customerNoteToSave: "Shared recent family bereavement — use supportive tone and suppress promotional offers.",
      reason: "Customer shared bereavement in the current message; suppressing promotional offers.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  if (medicalHardshipRegex.test(clean)) {
    return {
      sentiment: "distressed",
      lifeEvent: "medical_hardship",
      suppressPromotions: true,
      empathyLead: `I’m really sorry you’re dealing with a medical emergency, ${who}. Let’s focus on immediate liquid cash and steady support.`,
      customerNoteToSave: "Shared medical emergency / health hardship — prioritize accessible cash and pause promotional offers.",
      reason: "Customer shared a medical hardship in the current message; suppressing promotional offers.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  if (familyCrisisRegex.test(clean)) {
    return {
      sentiment: "concerned",
      lifeEvent: "family_crisis",
      suppressPromotions: true,
      empathyLead: `I’m really sorry you’re dealing with that, ${who}.`,
      customerNoteToSave: "Shared financial strain or family hardship — prioritize liquidity and pause promotional offers.",
      reason: "Customer expressed financial stress or family hardship; suppressing promotional offers.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  if (frustrationRegex.test(clean)) {
    return {
      sentiment: "frustrated",
      lifeEvent: "none",
      suppressPromotions: false,
      empathyLead: `Good catch, ${who} — sorry for missing that earlier.`,
      reason: "Customer pointed out a gap or mismatch in an earlier response.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  if (newFamilyRegex.test(clean)) {
    return {
      sentiment: "celebratory",
      lifeEvent: "new_family",
      suppressPromotions: false,
      empathyLead: `Congratulations on such an exciting family milestone, ${who}!`,
      customerNoteToSave: "Shared exciting family milestone (new baby / marriage) in chat.",
      reason: "Customer shared a joyful family milestone.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  if (homePurchaseRegex.test(clean)) {
    return {
      sentiment: "celebratory",
      lifeEvent: "home_purchase",
      suppressPromotions: false,
      empathyLead: `That’s an exciting milestone, ${who} —`,
      reason: "Customer mentioned buying a home.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  if (careerMilestoneRegex.test(clean)) {
    return {
      sentiment: "celebratory",
      lifeEvent: "career_milestone",
      suppressPromotions: false,
      empathyLead: `Congratulations on that career milestone, ${who}!`,
      customerNoteToSave: "Shared positive career milestone (promotion / raise / bonus).",
      reason: "Customer shared a career milestone.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  if (gratitudeRegex.test(clean)) {
    return {
      sentiment: "grateful",
      lifeEvent: "none",
      suppressPromotions: false,
      empathyLead: `You’re very welcome, ${who}!`,
      reason: "Customer expressed gratitude.",
      source: "heuristic",
      fromCurrentMessage: true,
      toolRef: empathyAssessToolRef,
    };
  }
  return null;
}

const EMPATHY_LLM_SYSTEM_PROMPT = [
  "You are CEP's Emotional & Life-Event Assessment layer (sfield tool cep.empathy.assess@1.0.0).",
  "Given a customer's first name, current message, optional recent summary, and Customer 360 advisor notes, assess their emotional state and any life event.",
  "Return ONLY strict JSON matching:",
  "{",
  '  "sentiment": "distressed" | "concerned" | "frustrated" | "celebratory" | "grateful" | "neutral",',
  '  "lifeEvent": "job_loss" | "medical_hardship" | "bereavement" | "family_crisis" | "home_purchase" | "new_family" | "retirement_transition" | "career_milestone" | "none",',
  '  "suppressPromotions": boolean,',
  '  "empathyLead": string (1 warm, brief opening sentence using firstName when sentiment != neutral, or "" if neutral),',
  '  "customerNoteToSave": string (optional, <= 140 chars; ONLY set if the CURRENT message reveals a NEW major life event not already in Customer 360 notes),',
  '  "fromCurrentMessage": boolean (true if the emotion/life event came from the current message; false if only from Customer 360 notes),',
  '  "reason": string (brief 1-sentence justification)',
  "}",
  "Rules:",
  "- Set suppressPromotions=true for job_loss, medical_hardship, bereavement, family_crisis, or distressed/anxious financial hardship (whether in current message OR Customer 360 notes).",
  "- Do NOT treat 'looking for a new job' as job_loss.",
  "- For routine neutral questions with neutral notes, return sentiment='neutral', lifeEvent='none', suppressPromotions=false, empathyLead='', fromCurrentMessage=false.",
].join("\n");

export async function assessEmotionalState(input: {
  firstName?: string;
  userMessage: string;
  ordinal: number;
  recentSummary?: string;
  customerNotes?: string;
  hasRetirementHistory?: boolean;
  llmJson?: (systemPrompt: string, userPrompt: string, signal: AbortSignal) => Promise<unknown | null>;
  signal?: AbortSignal;
}): Promise<EmotionalAssessment> {
  const clean = input.userMessage.trim();
  const msgHit = detectHeuristicFromMessage(clean, input.firstName, Boolean(input.hasRetirementHistory));
  if (msgHit) return msgHit;

  const noteHit = detectFromCustomerNotes(input.customerNotes, input.firstName);

  // Use live LLM classification when available and message/notes might contain subtle emotional cues
  const words = clean.split(/\s+/).filter(Boolean).length;
  const seemsPurelyMechanical = mechanicalWealthQuery.test(clean) && words <= 10 && !input.customerNotes?.trim();
  if (input.llmJson && !seemsPurelyMechanical && (words >= 5 || Boolean(input.customerNotes?.trim()))) {
    try {
      const llmSignal = input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(4_000)])
        : AbortSignal.timeout(4_000);
      const payload = JSON.stringify({
        firstName: input.firstName ?? "Customer",
        ordinal: input.ordinal,
        userMessage: clean.slice(0, 800),
        ...(input.customerNotes?.trim() ? { customer360Notes: input.customerNotes.trim().slice(0, 600) } : {}),
        ...(input.recentSummary?.trim() ? { recentContext: input.recentSummary.trim().slice(0, 600) } : {}),
      });
      const raw = await input.llmJson(EMPATHY_LLM_SYSTEM_PROMPT, payload, llmSignal);
      if (raw && typeof raw === "object") {
        const candidate = raw as Record<string, unknown>;
        const parsed = emotionalAssessmentSchema.safeParse({
          sentiment: candidate.sentiment ?? "neutral",
          lifeEvent: candidate.lifeEvent ?? "none",
          suppressPromotions: Boolean(candidate.suppressPromotions),
          empathyLead: typeof candidate.empathyLead === "string" ? candidate.empathyLead.trim().slice(0, 320) : "",
          ...(typeof candidate.customerNoteToSave === "string" && candidate.customerNoteToSave.trim()
            ? { customerNoteToSave: candidate.customerNoteToSave.trim().slice(0, 220) }
            : {}),
          reason: typeof candidate.reason === "string" && candidate.reason.trim()
            ? candidate.reason.trim().slice(0, 280)
            : "Assessed via LLM empathy layer.",
          source: noteHit && !candidate.fromCurrentMessage ? "customer360_notes" : "llm",
          fromCurrentMessage: Boolean(candidate.fromCurrentMessage),
          toolRef: empathyAssessToolRef,
        });
        if (parsed.success) {
          // Never drop a Customer 360 hardship suppression if the LLM missed it
          if (noteHit?.suppressPromotions && !parsed.data.suppressPromotions) {
            return noteHit;
          }
          return parsed.data;
        }
      }
    } catch {
      // Fall back gracefully to Customer 360 notes or neutral heuristic
    }
  }

  if (noteHit) return noteHit;

  return {
    sentiment: "neutral",
    lifeEvent: "none",
    suppressPromotions: false,
    empathyLead: "",
    reason: "Standard wealth inquiry with no acute emotional or hardship indicators.",
    source: "heuristic",
    fromCurrentMessage: false,
    toolRef: empathyAssessToolRef,
  };
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
    emotionalState?: EmotionalAssessment;
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
  const alreadyEmpathetic = /\b(sorry to hear|sorry you|so sorry for|congratulations|good catch|hi\s+\w|thanks for asking|you're welcome|you’re welcome|keeping your)\b/i.test(lower);

  const es = opts.emotionalState;
  if (es && es.empathyLead.trim()) {
    const lead = es.empathyLead.trim();
    const isUrgentEmpathy = es.sentiment === "distressed" || es.sentiment === "concerned" || es.sentiment === "frustrated";
    if (isUrgentEmpathy && !alreadyEmpathetic && !/\bsorry\b/i.test(lower)) {
      if (lead.endsWith("—") || lead.endsWith("-")) {
        return `${lead} ${lowercaseLead(intro)}`;
      }
      return `${lead} ${intro}`;
    }
    if (!alreadyHasName && !alreadyEmpathetic) {
      if (lead.endsWith("—") || lead.endsWith("-")) {
        return `${lead} ${lowercaseLead(intro)}`;
      }
      return `${lead} ${intro}`;
    }
  }

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
  opts: {
    firstName?: string;
    userMessage: string;
    ordinal: number;
    emotionalState?: EmotionalAssessment;
  },
): CompiledExperience {
  const nextIntro = personalizeIntro(compiled.display.intro, {
    firstName: opts.firstName,
    userMessage: opts.userMessage,
    ordinal: opts.ordinal,
    outcome: compiled.display.outcome,
    hasBlocks: compiled.display.blocks.length > 0,
    emotionalState: opts.emotionalState,
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
  if (jobSearchGuard.test(clean)) return false;
  if (hasRetirementHistory && jobLossRegex.test(clean)) return false;
  if (/\b(i\s+just\s+lost\s+my\s+job|i\s+lost\s+my\s+job|i\s+was\s+laid\s*off|got\s+laid\s*off|got\s+fired|lost\s+my\s+job\b.*\b(what|help|do|cash|money|plan|options)|medical\s+emergency|family\s+emergency|financial\s+crisis|passed\s+away)\b/i.test(clean)) {
    return true;
  }
  return false;
}

export function isHardshipLifeEvent(event?: EmotionalLifeEvent): boolean {
  return event === "job_loss" || event === "medical_hardship" || event === "bereavement" || event === "family_crisis";
}

export function buildHardshipSupportCanvas(
  prompt: string,
  profile: StoredCustomerProfile | undefined,
  emotionalState?: EmotionalAssessment,
): { intro: string; canvas: DynamicCanvasProps } {
  const name = firstNameOf(profile?.displayName) ?? "there";
  const event: EmotionalLifeEvent = emotionalState?.lifeEvent && emotionalState.lifeEvent !== "none"
    ? emotionalState.lifeEvent
    : jobLossRegex.test(prompt)
      ? "job_loss"
      : bereavementRegex.test(prompt)
        ? "bereavement"
        : medicalHardshipRegex.test(prompt)
          ? "medical_hardship"
          : "family_crisis";
  const isJobLoss = event === "job_loss";
  const isBereavement = event === "bereavement";
  const isMedical = event === "medical_hardship";
  const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
  const cashCents = profile?.cashCents ?? 0;
  const availCents = profile?.availableBalanceCents ?? cashCents;
  const totalCents = (profile?.cashCents ?? 0) + (profile?.equityCents ?? 0) + (profile?.fixedIncomeCents ?? 0);
  const estMonthlyExpensesCents = 450_000; // $4,500 illustrative baseline
  const runwayMonths = cashCents > 0 ? Math.max(0.5, Math.round((cashCents / estMonthlyExpensesCents) * 10) / 10) : 0;

  const intro = emotionalState?.empathyLead?.trim()
    ? `${emotionalState.empathyLead.trim()} Let’s focus on protecting your immediate cash cushion and practical next steps together.`
    : isJobLoss
      ? `I’m really sorry to hear about losing your job, ${name}. Take a breath — let’s focus on protecting your immediate cash cushion and practical next steps together.`
      : isBereavement
        ? `I’m so sorry for your loss, ${name}. Please take all the time you need — here is a clear view of your accessible funds and gentle next steps when you’re ready.`
        : `I’m really sorry you’re going through a difficult time, ${name}. Let’s look at your immediate liquid cash and steady next steps so you have clarity right now.`;

  const title = isJobLoss
    ? "Job-Loss Financial Stability & Cash Runway"
    : isBereavement
      ? "Bereavement & Account Continuity Support"
      : isMedical
        ? "Medical Hardship Liquidity & Cash Plan"
        : "Emergency Liquidity & Stability Plan";

  const checklistItems = isJobLoss
    ? [
        "Pause non-essential recurring investment transfers to preserve liquid cash.",
        "Confirm severance payout timing, unused PTO payout, and state unemployment eligibility.",
        "Review health coverage options (COBRA vs. marketplace or spouse plan) within the 60-day window.",
        "Check 401(k) rollover or leave-in-place options — avoid early withdrawals that trigger taxes/penalties.",
        "Map essential monthly expenses against your current cash buffer.",
      ]
    : isBereavement
      ? [
          "Focus on immediate cash availability — avoid making irreversible investment decisions right away.",
          "Pause discretionary auto-transfers while household bills and estate matters settle.",
          "Review account beneficiaries and transfer-on-death designations when ready.",
          "Connect with our dedicated Transition & Estate Specialist team for paperwork guidance.",
        ]
      : [
          "Verify immediately available cash before tapping invested holdings.",
          "Pause discretionary automatic contributions while expenses stabilize.",
          "Review whether any near-term goal timelines should be temporarily adjusted.",
          "Speak with a live advisor if you need a tailored liquidity or withdrawal plan.",
        ];

  return {
    intro,
    canvas: {
      title,
      badge: "Life Event Support",
      subtitle: `${profile?.displayName ?? "Customer"} · Grounded in Customer 360 & sfield Empathy Layer`,
      generatedBy: "synthesizer",
      dataSource: `Customer 360 Balances · sfield ${empathyAssessToolRef}`,
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
          body: `You currently have ${usd(cashCents)} in liquid cash (${usd(availCents)} available). Promotional investment offers have been automatically paused while we focus on stability.`,
        },
        {
          type: "checklist",
          title: isJobLoss ? "First-30-Days Financial Checklist" : "Immediate Stability Checklist",
          items: checklistItems,
        },
      ],
      disclaimer: "Balances reflect live Customer 360 records. Runway estimate is illustrative; speak with a licensed advisor for personalized tax or benefits advice.",
    },
  };
}
