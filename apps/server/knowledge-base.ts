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

function stem(token: string): string {
  return token.replace(/(?:ing|tion|sions?|ments?|ies|ed|es|s)$/, (m) => (m === "ies" ? "y" : ""));
}

const VEC_DIM = 256;
function fnvHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic 256-dim L2-normalized semantic vector over stemmed tokens + character 3/4-grams (offline, zero external model). */
export function embedHybridVector(text: string): Float32Array {
  const vec = new Float32Array(VEC_DIM);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const root = stem(tok);
    const h1 = fnvHash(`w:${tok}`);
    vec[h1 % VEC_DIM] += (h1 & 1 ? 1 : -1) * 1.6;
    if (root.length >= 3 && root !== tok) {
      const hr = fnvHash(`r:${root}`);
      vec[hr % VEC_DIM] += (hr & 1 ? 1 : -1) * 1.2;
    }
    const padded = `^${root}$`;
    for (let i = 0; i <= padded.length - 3; i++) {
      const tri = padded.slice(i, i + 3);
      const hg = fnvHash(`g3:${tri}`);
      vec[hg % VEC_DIM] += (hg & 1 ? 1 : -1) * 0.45;
    }
  }
  let norm = 0;
  for (let i = 0; i < VEC_DIM; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < VEC_DIM; i++) vec[i] = vec[i]! / norm;
  return vec;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return Math.max(0, dot);
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
    if (qTokens.length === 0) return { query, retrievalMode: "hybrid_bm25_vector", citations: [] };
    const qStems = [...new Set(qTokens.map(stem))];
    const qVec = embedHybridVector(query);

    // Collect all active chunks across enabled documents for corpus-wide BM25 IDF + vector cosine.
    type Entry = {
      doc: KnowledgeDocument;
      chunkIndex: number;
      chunk: string;
      tokens: string[];
      stems: string[];
      titleStems: Set<string>;
      bm25: number;
      vecSim: number;
    };
    const corpus: Entry[] = [];
    for (const doc of this.docs) {
      if (!doc.enabled) continue;
      const titleStems = new Set(tokenize(`${doc.title} ${doc.tags.join(" ")}`).map(stem));
      const chunks = splitChunks(doc.content);
      chunks.forEach((chunk, chunkIndex) => {
        const tokens = tokenize(chunk);
        corpus.push({
          doc, chunkIndex, chunk, tokens, stems: tokens.map(stem), titleStems,
          bm25: 0, vecSim: cosineSimilarity(qVec, embedHybridVector(`${doc.title} ${doc.tags.join(" ")} ${chunk}`)),
        });
      });
    }
    if (corpus.length === 0) return { query, retrievalMode: "hybrid_bm25_vector", citations: [] };

    // BM25 (k1=1.5, b=0.75) with title/tag boost.
    const N = corpus.length;
    const avgdl = corpus.reduce((s, e) => s + e.stems.length, 0) / Math.max(N, 1);
    const df = new Map<string, number>();
    for (const qs of qStems) {
      df.set(qs, corpus.filter((e) => e.stems.includes(qs) || e.titleStems.has(qs)).length);
    }
    const k1 = 1.5;
    const b = 0.75;
    for (const entry of corpus) {
      const dl = Math.max(1, entry.stems.length);
      let bm25 = 0;
      for (const qs of qStems) {
        const n = df.get(qs) ?? 0;
        if (n === 0) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const tf = entry.stems.filter((t) => t === qs).length + (entry.titleStems.has(qs) ? 1.5 : 0);
        if (tf > 0) bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / Math.max(avgdl, 1)))));
      }
      entry.bm25 = bm25;
    }

    // Reciprocal Rank Fusion (RRF) of BM25 + Vector Cosine rankings.
    const bm25Rank = new Map<Entry, number>([...corpus].sort((a, b) => b.bm25 - a.bm25).map((e, i) => [e, i + 1]));
    const vecRank = new Map<Entry, number>([...corpus].sort((a, b) => b.vecSim - a.vecSim).map((e, i) => [e, i + 1]));
    const maxBm25 = Math.max(0.0001, ...corpus.map((e) => e.bm25));

    const scored = corpus
      .filter((e) => e.bm25 > 0.35 || e.vecSim >= 0.24)
      .map((e) => {
        const rrf = (e.bm25 > 0 ? 1 / (25 + (bm25Rank.get(e) ?? N)) : 0) + (e.vecSim > 0 ? 1 / (25 + (vecRank.get(e) ?? N)) : 0);
        const bm25Norm = Math.min(1, e.bm25 / maxBm25);
        const combined = Math.min(99, Math.max(12, Math.round((bm25Norm * 0.55 + e.vecSim * 0.45) * 95 + rrf * 120)));
        return {
          citation: {
            docId: e.doc.id,
            docTitle: e.doc.title,
            version: e.doc.version,
            domain: e.doc.domain,
            chunkIndex: e.chunkIndex + 1,
            score: combined,
            bm25Score: Number(e.bm25.toFixed(2)),
            vectorScore: Number((e.vecSim * 100).toFixed(1)),
            excerpt: e.chunk.slice(0, 380),
          } as KnowledgeCitation,
          sortKey: combined + rrf * 200,
        };
      })
      .sort((a, b) => b.sortKey - a.sortKey);

    const citations = scored.slice(0, limit).map((s) => s.citation);

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

    return { query, retrievalMode: "hybrid_bm25_vector", citations, ...(suggestedFollowUp ? { suggestedFollowUp } : {}) };
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
