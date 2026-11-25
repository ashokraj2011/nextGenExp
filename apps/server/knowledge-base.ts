import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DynamicCanvasProps } from "../../packages/contracts/dynamic-canvas";
import {
  knowledgeDocumentSchema,
  knowledgeDocumentUpsertSchema,
  type KnowledgeBaseView,
  type KnowledgeCitation,
  type KnowledgeDocument,
  type KnowledgeDocumentUpsertInput,
  type KnowledgeSearchResult,
} from "../../packages/contracts/knowledge-base";

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "when", "where", "how", "are", "our", "your",
  "can", "does", "from", "into", "about", "have", "will", "should", "must", "any", "all", "under",
  "over", "more", "than", "before", "after", "per", "not", "you", "they", "their", "its",
]);

function defaultDocuments(nowIso: string): KnowledgeDocument[] {
  return [
    {
      id: "wire_transfer_compliance_policy",
      title: "Wire Transfer Compliance & OFAC Policy",
      domain: "wealth",
      version: "2.4",
      tags: ["wire", "fedwire", "swift", "ofac", "hitl", "compliance", "cutoff"],
      enabled: true,
      isBuiltIn: true,
      updatedAt: nowIso,
      content: [
        "Section 1 — Automated Threshold & HITL Approval Gate: Domestic Fedwire and International SWIFT transfers up to $10,000 may settle automatically after beneficiary verification. Any wire transfer exceeding $10,000 MUST pause at a SHA-256 digest-bound Human-in-the-Loop (HITL) compliance gate prior to clearinghouse release.",
        "Section 2 — OFAC & Velocity Pre-Flight Screening: All outgoing wires above $5,000 or routed via International SWIFT require real-time OFAC sanctions and account velocity screening. Any transaction scoring above 55/100 is flagged as Elevated Review.",
        "Section 3 — Daily Settlement Cutoffs & Recall Window: Domestic Fedwire cutoff is 5:00 PM ET for same-day settlement; International SWIFT cutoff is 3:30 PM ET. Clients may cancel an in-flight wire job during the pre-clearinghouse dispatch window before settlement confirmation is finalized.",
      ].join("\n\n"),
    },
    {
      id: "tax_loss_harvesting_policy",
      title: "Tax-Loss Harvesting & IRS 30-Day Wash-Sale Policy",
      domain: "wealth",
      version: "1.8",
      tags: ["tax", "harvest", "wash-sale", "irs", "capital-gains", "losses"],
      enabled: true,
      isBuiltIn: true,
      updatedAt: nowIso,
      content: [
        "Section 1 — Tax-Loss Offset Mechanics: Realized capital gains from selling appreciated equities (such as AAPL or NVDA) may be offset dollar-for-dollar by harvesting unrealized capital losses in underperforming lots (such as INTC). Up to $3,000 of net excess capital losses can also offset ordinary income annually.",
        "Section 2 — IRS Section 1091 30-Day Wash-Sale Rule: Taxpayers must NOT repurchase the same or a substantially identical security within 30 calendar days BEFORE or AFTER a loss-harvesting sale. CEP automatically checks the 30-day wash-sale ledger and warns prior to execution.",
        "Section 3 — High-Value Execution & Tax Disclaimer: Combined trade bundles exceeding $10,000 gross market value require explicit HITL approval. CEP provides illustrative tax-lot simulations for educational planning and does not constitute formal legal or CPA tax advice.",
      ].join("\n\n"),
    },
    {
      id: "sre_p1_rollback_runbook",
      title: "SRE P1 Production Rollback & Change Control Runbook",
      domain: "operations",
      version: "3.1",
      tags: ["sre", "p1", "rollback", "latency", "5xx", "pagerduty", "canary"],
      enabled: true,
      isBuiltIn: true,
      updatedAt: nowIso,
      content: [
        "Section 1 — P1 Rollback Trigger Thresholds: An automated P1 incident and rollback recommendation is triggered whenever edge 5xx error rate exceeds 2.0% OR p95 latency exceeds 350ms sustained for 3 consecutive minutes following a release deployment.",
        "Section 2 — Mandatory Escalation & 4-Eyes Change Control: Every P1 production rollback or Global blast-radius hotfix MUST page the On-Call SRE Commander via the PagerDuty connector and capture SHA-256 signed HITL approval. Global rollouts enforce 4-eyes dual control (approver must differ from requester).",
        "Section 3 — Canary Verification Soak: Following rollback execution to the last known healthy revision, automated canary telemetry monitors 5xx rate (<0.1%) and p95 latency (<80ms) before marking the incident resolved.",
      ].join("\n\n"),
    },
    {
      id: "enterprise_deal_desk_policy",
      title: "Enterprise Discount Authority & Deal Desk Matrix",
      domain: "sales",
      version: "2.0",
      tags: ["deal-desk", "discount", "arr", "approval", "cfo", "revops", "sales"],
      enabled: true,
      isBuiltIn: true,
      updatedAt: nowIso,
      content: [
        "Section 1 — Standard Discount Authority Cap: Account Executives have self-service authority to grant up to a 15% discount on standard annual enterprise subscriptions with zero Deal Desk sign-off.",
        "Section 2 — Escalated HITL Approval Tiers: Discounts between 16% and 25% require VP Revenue Operations HITL approval via CEP Deal Desk (with SHA-256 audit logging). Discounts exceeding 25% OR contracts above $500,000 ARR require CFO 4-eyes dual control.",
        "Section 3 — Multi-Year Commitments & Margin Protection: Any discount above 20% should pair with a 24-month or 36-month multi-year commitment or annual upfront payment to preserve net margin.",
      ].join("\n\n"),
    },
  ];
}

export function splitChunks(content: string): string[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 20);
  if (paragraphs.length > 0) return paragraphs;
  const trimmed = content.replace(/\s+/g, " ").trim();
  return trimmed ? [trimmed] : [];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%.-]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

export function isPolicyQuestion(prompt: string): boolean {
  const lower = prompt.toLowerCase().trim();
  if (lower.length < 10) return false;
  // Never hijack rule authoring or explicit action commands
  if (/\bcreate\s+(?:a\s+)?rule\b/i.test(lower)) return false;
  if (/^\s*(?:i want to |please )?(?:sell|buy|initiate|send|run|execute|apply for|start|create)\b/i.test(lower)) {
    return false;
  }
  return /\b(?:policy|policies|runbook|guideline|guidelines|compliance|cutoff|cut-?off|threshold|authority|cap|wash[\s-]*sale|section\s*1091|ofac|matrix|sla|slo|procedure|according\s+to\s+(?:our|the)\s+(?:doc|policy|runbook))\b/i.test(lower);
}

export class KnowledgeBaseStore {
  private readonly filePath: string;
  private docs: KnowledgeDocument[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "knowledge-base.json");
    this.docs = this.load();
  }

  private load(): KnowledgeDocument[] {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          const valid = raw
            .map((item) => knowledgeDocumentSchema.safeParse(item))
            .filter((res): res is { success: true; data: KnowledgeDocument } => res.success)
            .map((res) => res.data);
          if (valid.length > 0) return valid;
        }
      } catch { /* fall through */ }
    }
    const seeded = defaultDocuments(new Date().toISOString());
    this.save(seeded);
    return seeded;
  }

  private save(next: KnowledgeDocument[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf8");
    this.docs = next;
  }

  view(): KnowledgeBaseView {
    const documents = this.docs.map((doc) => ({
      ...doc,
      tags: [...doc.tags],
      chunkCount: splitChunks(doc.content).length,
    }));
    return {
      documents,
      totalChunks: documents.reduce((sum, d) => sum + d.chunkCount, 0),
    };
  }

  upsert(rawInput: KnowledgeDocumentUpsertInput): KnowledgeBaseView {
    const parsed = knowledgeDocumentUpsertSchema.parse(rawInput);
    const existing = this.docs.find((d) => d.id === parsed.id);
    const record: KnowledgeDocument = {
      ...parsed,
      ...(existing?.isBuiltIn ? { isBuiltIn: true } : {}),
      updatedAt: new Date().toISOString(),
    };
    const next = existing
      ? this.docs.map((d) => (d.id === parsed.id ? record : d))
      : [record, ...this.docs];
    this.save(next);
    return this.view();
  }

  deleteOrReset(id: string): KnowledgeBaseView {
    const builtIn = defaultDocuments(new Date().toISOString()).find((d) => d.id === id);
    if (builtIn) {
      this.save(this.docs.map((d) => (d.id === id ? builtIn : d)));
    } else {
      this.save(this.docs.filter((d) => d.id !== id));
    }
    return this.view();
  }

  search(query: string, limit = 3): KnowledgeSearchResult {
    const qTokens = [...new Set(tokenize(query))];
    if (qTokens.length === 0) return { query, citations: [] };

    const scored: KnowledgeCitation[] = [];
    for (const doc of this.docs) {
      if (!doc.enabled) continue;
      const titleTokens = new Set(tokenize(`${doc.title} ${doc.tags.join(" ")}`));
      const chunks = splitChunks(doc.content);
      chunks.forEach((chunk, chunkIndex) => {
        const chunkTokens = tokenize(chunk);
        const chunkSet = new Set(chunkTokens);
        let score = 0;
        for (const qt of qTokens) {
          if (chunkSet.has(qt)) score += 3;
          else if (chunk.toLowerCase().includes(qt)) score += 1.5;
          if (titleTokens.has(qt)) score += 2.5;
        }
        if (score >= 3) {
          const normalizedScore = Math.min(99, Math.round((score / Math.max(qTokens.length * 4.5, 4)) * 100));
          scored.push({
            docId: doc.id,
            docTitle: doc.title,
            version: doc.version,
            domain: doc.domain,
            chunkIndex: chunkIndex + 1,
            score: normalizedScore,
            excerpt: chunk.slice(0, 380),
          });
        }
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const citations = scored.slice(0, limit);

    let suggestedFollowUp: KnowledgeSearchResult["suggestedFollowUp"];
    const topDoc = citations[0]?.docId;
    if (topDoc === "wire_transfer_compliance_policy") {
      suggestedFollowUp = { label: "Start Governed Wire Workflow", prompt: "I want to initiate a wire transfer" };
    } else if (topDoc === "tax_loss_harvesting_policy") {
      suggestedFollowUp = { label: "Simulate 40% AAPL Tax Harvest", prompt: "I want to sell 40% of my Apple shares" };
    } else if (topDoc === "sre_p1_rollback_runbook") {
      suggestedFollowUp = { label: "Open P1 Incident Triage", prompt: "Build an IT incident triage dashboard for our active P1 alert" };
    } else if (topDoc === "enterprise_deal_desk_policy") {
      suggestedFollowUp = { label: "Open Acme Deal Desk Approval", prompt: "Show the enterprise discount approval card for Acme Cloud Corp" };
    }

    return { query, citations, ...(suggestedFollowUp ? { suggestedFollowUp } : {}) };
  }
}

export function buildPolicyRagCanvas(result: KnowledgeSearchResult): { intro: string; canvas: DynamicCanvasProps } {
  const top = result.citations[0];
  const intro = top
    ? `Grounded in **${top.docTitle} (v${top.version})** and ${result.citations.length} verified policy clause${result.citations.length === 1 ? "" : "s"} from CEP Knowledge Base:`
    : "No matching policy documents were found in the CEP Knowledge Base.";

  const canvas: DynamicCanvasProps = {
    title: top ? `${top.docTitle} · Verified Citations`.slice(0, 94) : "Knowledge Base Policy Search",
    badge: `Policy RAG · ${result.citations.length} Citation${result.citations.length === 1 ? "" : "s"}`.slice(0, 42),
    subtitle: `Retrieved deterministically from knowledge-base.json for "${result.query.slice(0, 120)}"`.slice(0, 250),
    generatedBy: "synthesizer",
    dataSource: "CEP Policy Knowledge Base (knowledge-base.json)",
    prompt: result.query.slice(0, 580),
    nodes: [
      ...(top
        ? [{
            type: "callout" as const,
            tone: "highlight" as const,
            title: `Primary Clause · ${top.docTitle} (v${top.version} §${top.chunkIndex})`.slice(0, 88),
            body: top.excerpt.slice(0, 580),
          }]
        : []),
      ...(result.citations.length > 0
        ? [{
            type: "table" as const,
            caption: "All Cited Policy Clauses (Ranked by Relevance)",
            columns: ["Document", "Ver / §", "Match", "Verified Clause Excerpt"],
            rows: result.citations.map((c) => [
              c.docTitle.slice(0, 44),
              `v${c.version} · §${c.chunkIndex}`.slice(0, 24),
              `${c.score}%`,
              (c.excerpt.slice(0, 72) + (c.excerpt.length > 72 ? "…" : "")).slice(0, 78),
            ]),
          }]
        : []),
      ...(result.citations.length > 1
        ? [{
            type: "checklist" as const,
            title: "Additional Referenced Clauses",
            items: result.citations.slice(1).map((c) => `[v${c.version} §${c.chunkIndex}] ${c.excerpt}`.slice(0, 152)),
          }]
        : []),
    ],
    disclaimer: "Strictly grounded in published enterprise policy documents in CEP Knowledge Base. Zero external web or unverified model claims.",
    ...(result.suggestedFollowUp ? { suggestedFollowUp: result.suggestedFollowUp.prompt.slice(0, 155) } : {}),
  };

  return { intro, canvas };
}
