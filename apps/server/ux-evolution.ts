import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  uxProposalSchema,
  type UxEvolutionView,
  type UxFrictionReason,
  type UxProposal,
} from "../../packages/contracts/ux-evolution";
import { widgetDraftSchema, type SavedWidget, type WidgetDraft } from "../../packages/contracts/widget";
import type { GatewaySettings } from "./gateway";
import { generateWidgetDraftWithLlm } from "./dynamic-ui-generator";
import type { KnowledgeBaseStore } from "./knowledge-base";
import type { TurnRecord } from "./store";
import { generateWidgetFromText, type WidgetLibraryStore } from "./widget-library";

interface PersistedEvolutionState {
  proposals: UxProposal[];
  lastStats: UxEvolutionView["stats"];
  lastScannedAt?: string;
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "what", "when", "where", "which", "would", "could", "should",
  "about", "into", "your", "their", "there", "here", "today", "tomorrow", "please", "help", "want", "need",
  "show", "make", "build", "create", "just", "very", "more", "some", "also", "like", "give", "tell", "know",
  "hello", "thanks", "thank", "okay", "sure", "good", "morning", "afternoon", "evening",
]);

function extractTopicKey(message: string): { topicKey: string; label: string } | null {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (words.length === 0) return null;
  const top = words.slice(0, 2);
  const topicKey = top.join("_").slice(0, 48);
  const label = top.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return { topicKey, label };
}

function buildSynthesizedProposal(input: {
  topicKey: string;
  label: string;
  samplePrompts: string[];
  occurrenceCount: number;
  frictionReason: UxFrictionReason;
}): { widgetDraft: WidgetDraft; policyDraft: { title: string; category: string; body: string } } {
  const primaryPrompt = input.samplePrompts[0]!;
  const lower = primaryPrompt.toLowerCase();

  if (/401k|rollover|ira/.test(lower)) {
    return {
      widgetDraft: widgetDraftSchema.parse({
        name: "401(k) Rollover Concierge",
        kind: "checklist",
        prompt: primaryPrompt,
        badge: "Rollover Guide",
        title: "401(k) to IRA Rollover Checklist",
        body: "Direct trustee-to-trustee rollover avoids mandatory 20% federal tax withholding and 60-day rollover penalties.",
        ctaLabel: "Start direct rollover",
        accentTop: true,
        availableForConsumption: true,
        recommendedComponent: "PznStepList",
        steps: [
          "Confirm prior employer plan custodian & vested balance",
          "Select Traditional IRA (pre-tax) or Roth IRA (conversion)",
          "Request direct trustee-to-trustee transfer to avoid 20% withholding",
          "Reinvest settled funds according to your target allocation",
        ],
      }),
      policyDraft: {
        title: "401(k) Direct Rollover Policy",
        category: "Retirement",
        body: "Direct trustee-to-trustee 401(k) rollovers incur zero mandatory withholding. Indirect 60-day rollovers are subject to 20% federal tax withholding and one-rollover-per-year IRA limits.",
      },
    };
  }

  if (/crypto|bitcoin|ethereum|digital asset/.test(lower)) {
    return {
      widgetDraft: widgetDraftSchema.parse({
        name: "Crypto Tax & Wash-Sale Guide",
        kind: "advisory",
        prompt: primaryPrompt,
        badge: "Crypto Tax Rules",
        title: "Digital Asset Tax Reporting Summary",
        body: "Review short-term vs. long-term capital gains holding periods, cost-basis lot tracking (FIFO/Specific ID), and Form 1099-DA reporting requirements.",
        ctaLabel: "Review portfolio tax lots",
        accentTop: true,
        availableForConsumption: true,
        recommendedComponent: "PznContentCard",
      }),
      policyDraft: {
        title: "Digital Asset & Crypto Tax Policy",
        category: "Tax & Compliance",
        body: "Cryptocurrency dispositions are treated as property transactions subject to short-term (<=1 year) or long-term (>1 year) capital gains rates. Clients must maintain cost-basis lot records for Form 1099-DA reporting.",
      },
    };
  }

  const baseWidget = generateWidgetFromText(`Build a helpful ${input.label} interactive widget for: ${primaryPrompt}`);
  return {
    widgetDraft: widgetDraftSchema.parse({
      ...baseWidget,
      name: `${input.label} Assistant`.slice(0, 72),
      badge: `${input.label} Live`.slice(0, 40),
      availableForConsumption: true,
    }),
    policyDraft: {
      title: `${input.label} Guidance Standard`.slice(0, 96),
      category: "Self-Evolved Policy",
      body: `Standardized guidance automatically proposed from ${input.occurrenceCount} customer conversation(s) asking: "${primaryPrompt}". Review and customize clauses before publishing broadly.`,
    },
  };
}

const SIMULATED_UNMET_TURNS: { message: string; reason: UxFrictionReason }[] = [
  { message: "How do I rollover my old 401k without paying the 20% tax penalty?", reason: "plain_chat_miss" },
  { message: "Can you walk me through a 401k rollover to an IRA?", reason: "repeated_ask" },
  { message: "How do crypto taxes and 1099-DA reporting work on Bitcoin gains?", reason: "unhelpful_feedback" },
];

export class UxEvolutionStore {
  private readonly filePath: string;
  private state: PersistedEvolutionState;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "ux-proposals.json");
    this.state = this.load();
  }

  private load(): PersistedEvolutionState {
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedEvolutionState>;
        const proposals = Array.isArray(parsed.proposals)
          ? parsed.proposals.flatMap((p) => {
              const res = uxProposalSchema.safeParse(p);
              return res.success ? [res.data] : [];
            })
          : [];
        return {
          proposals,
          lastStats: parsed.lastStats ?? {
            scannedTurns: 0, plainChatMisses: 0, unhelpfulTurns: 0,
            pendingCount: proposals.filter((p) => p.status === "pending").length,
            shippedCount: proposals.filter((p) => p.status === "approved").length,
          },
          lastScannedAt: parsed.lastScannedAt,
        };
      } catch { /* fall through */ }
    }
    return {
      proposals: [],
      lastStats: { scannedTurns: 0, plainChatMisses: 0, unhelpfulTurns: 0, pendingCount: 0, shippedCount: 0 },
    };
  }

  private save() {
    this.state.lastStats.pendingCount = this.state.proposals.filter((p) => p.status === "pending").length;
    this.state.lastStats.shippedCount = this.state.proposals.filter((p) => p.status === "approved").length;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  view(): UxEvolutionView {
    return {
      proposals: this.state.proposals.slice(),
      stats: {
        ...this.state.lastStats,
        pendingCount: this.state.proposals.filter((p) => p.status === "pending").length,
        shippedCount: this.state.proposals.filter((p) => p.status === "approved").length,
      },
      ...(this.state.lastScannedAt ? { lastScannedAt: this.state.lastScannedAt } : {}),
    };
  }

  async scanAndDraft(input: {
    turns: TurnRecord[];
    existingWidgets: SavedWidget[];
    gateway?: GatewaySettings | null;
    dataDir: string;
    includeSampleTraffic?: boolean;
  }): Promise<{ created: UxProposal[]; view: UxEvolutionView }> {
    let plainChatMisses = 0;
    let unhelpfulTurns = 0;

    type Cluster = {
      topicKey: string;
      label: string;
      prompts: string[];
      reason: UxFrictionReason;
    };
    const clusters = new Map<string, Cluster>();

    const ingest = (message: string, reason: UxFrictionReason) => {
      const topic = extractTopicKey(message);
      if (!topic) return;
      const existing = clusters.get(topic.topicKey);
      if (existing) {
        if (!existing.prompts.includes(message)) existing.prompts.push(message);
        if (reason === "unhelpful_feedback") existing.reason = "unhelpful_feedback";
        else if (existing.prompts.length > 1) existing.reason = "repeated_ask";
      } else {
        clusters.set(topic.topicKey, {
          topicKey: topic.topicKey,
          label: topic.label,
          prompts: [message],
          reason,
        });
      }
    };

    for (const turn of input.turns) {
      const msg = turn.public.message?.trim() ?? "";
      if (msg.length < 6) continue;
      const isPlain = turn.public.actionMode === "plain_chat";
      const isUnhelpful = turn.public.feedback === "unhelpful";
      if (isPlain) plainChatMisses += 1;
      if (isUnhelpful) unhelpfulTurns += 1;
      if (isUnhelpful) ingest(msg, "unhelpful_feedback");
      else if (isPlain) ingest(msg, "plain_chat_miss");
    }

    if (input.includeSampleTraffic || clusters.size === 0) {
      for (const sample of SIMULATED_UNMET_TURNS) {
        ingest(sample.message, sample.reason);
        if (sample.reason === "plain_chat_miss") plainChatMisses += 1;
        if (sample.reason === "unhelpful_feedback") unhelpfulTurns += 1;
      }
    }

    const activeWidgetNames = new Set(
      input.existingWidgets
        .filter((w) => w.availableForConsumption)
        .map((w) => w.name.toLowerCase()),
    );
    const existingTopics = new Set(
      this.state.proposals
        .filter((p) => p.status !== "dismissed")
        .map((p) => p.topicKey),
    );

    const created: UxProposal[] = [];
    const candidateClusters = [...clusters.values()]
      .filter((c) => !existingTopics.has(c.topicKey))
      .filter((c) => ![...activeWidgetNames].some((name) => name.includes(c.label.toLowerCase().split(" ")[0]!)))
      .slice(0, 3);

    for (const cluster of candidateClusters) {
      const synthesized = buildSynthesizedProposal({
        topicKey: cluster.topicKey,
        label: cluster.label,
        samplePrompts: cluster.prompts.slice(0, 5),
        occurrenceCount: cluster.prompts.length,
        frictionReason: cluster.reason,
      });

      let widgetDraft = synthesized.widgetDraft;
      let generatedBy: "copilot_llm" | "synthesizer" = "synthesizer";

      if (input.gateway) {
        try {
          const llmDraft = await generateWidgetDraftWithLlm(
            `Create a concise, helpful CEP interactive widget to solve this recurring customer question: "${cluster.prompts[0]}"`,
            input.gateway,
            input.dataDir,
          );
          widgetDraft = widgetDraftSchema.parse({
            ...llmDraft,
            availableForConsumption: true,
          });
          generatedBy = "copilot_llm";
        } catch {
          // Use deterministic high-craft fallback
        }
      }

      const proposal: UxProposal = uxProposalSchema.parse({
        id: `uxp_${randomUUID().slice(0, 10)}`,
        status: "pending",
        topicKey: cluster.topicKey,
        detectedPattern: `${cluster.label} (${cluster.reason.replace(/_/g, " ")})`,
        frictionReason: cluster.reason,
        samplePrompts: cluster.prompts.slice(0, 5),
        occurrenceCount: cluster.prompts.length,
        title: widgetDraft.name,
        summary: `Detected ${cluster.prompts.length} unmet turn(s) around "${cluster.label}". Approving will ship "${widgetDraft.name}" live in chat and index its Policy RAG guide.`,
        generatedBy,
        widgetDraft,
        policyDraft: synthesized.policyDraft,
        createdAt: new Date().toISOString(),
      });
      this.state.proposals.unshift(proposal);
      created.push(proposal);
    }

    this.state.lastStats = {
      scannedTurns: input.turns.length,
      plainChatMisses,
      unhelpfulTurns,
      pendingCount: this.state.proposals.filter((p) => p.status === "pending").length,
      shippedCount: this.state.proposals.filter((p) => p.status === "approved").length,
    };
    this.state.lastScannedAt = new Date().toISOString();
    this.save();
    return { created, view: this.view() };
  }

  approveProposal(
    id: string,
    deps: {
      principalId: string;
      widgetLibrary: WidgetLibraryStore;
      knowledgeBase: KnowledgeBaseStore;
      now: number;
    },
  ): { proposal: UxProposal; view: UxEvolutionView } {
    const target = this.state.proposals.find((p) => p.id === id);
    if (!target) throw new Error("UX proposal not found.");
    if (target.status === "approved") return { proposal: target, view: this.view() };

    const savedWidget = deps.widgetLibrary.change(
      deps.principalId,
      {
        operation: "save",
        widget: {
          ...target.widgetDraft,
          availableForConsumption: true,
        },
      },
      deps.now,
    );

    let shippedPolicyDocId: string | undefined;
    if (target.policyDraft) {
      const policyId = `ux_${target.topicKey.replace(/[^a-z0-9_-]/g, "_").slice(0, 32)}`;
      deps.knowledgeBase.upsert({
        id: policyId,
        title: target.policyDraft.title,
        domain: "wealth",
        version: "v1.0",
        enabled: true,
        tags: [target.policyDraft.category, "self-evolved"],
        content: target.policyDraft.body,
      });
      shippedPolicyDocId = policyId;
    }

    target.status = "approved";
    target.shippedWidgetId = savedWidget.widget?.id;
    target.shippedPolicyDocId = shippedPolicyDocId;
    target.shippedAt = new Date().toISOString();
    this.save();
    return { proposal: target, view: this.view() };
  }

  dismissProposal(id: string): UxEvolutionView {
    const target = this.state.proposals.find((p) => p.id === id);
    if (target) {
      target.status = "dismissed";
      this.save();
    }
    return this.view();
  }
}
