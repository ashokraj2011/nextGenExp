/**
 * Semantic VectorMemoryIndex & pluggable EmbeddingProvider for @sfield/core (§10, §17.5).
 *
 * Combines dense cosine similarity (from any custom/LLM EmbeddingProvider or the built-in
 * deterministic zero-dependency HashEmbeddingProvider) with lexical overlap boosting while
 * honoring tenant boundaries and deletion generations.
 */
import type { MemoryIndex, MemoryItem, MemoryOutboxEvent } from "../types/memory.js";
import { scopeKey } from "../types/memory.js";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * Computes cosine similarity between two equal-length vectors in [-1, 1].
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic zero-dependency local embedder using token + character trigram feature hashing.
 * Ideal for local development, offline tests, and hybrid fallback when no external embedding API is configured.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = "hash-local";
  readonly dimensions: number;

  constructor(dimensions = 128) {
    this.dimensions = Math.max(16, dimensions);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((raw) => {
      const vec = new Array<number>(this.dimensions).fill(0);
      const clean = raw.toLowerCase().trim();
      const tokens = clean.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
      for (const tok of tokens) {
        const idx = fnv1a(`w:${tok}`) % this.dimensions;
        vec[idx] = (vec[idx] ?? 0) + 2.0;
        // Add character trigrams so morphological variants ("retire"/"retirement", "invest"/"investment") align.
        if (tok.length >= 3) {
          for (let i = 0; i <= tok.length - 3; i++) {
            const tri = tok.slice(i, i + 3);
            const tIdx = fnv1a(`t:${tri}`) % this.dimensions;
            vec[tIdx] = (vec[tIdx] ?? 0) + 0.6;
          }
        }
      }
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += (vec[i] ?? 0) ** 2;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
      }
      return vec;
    });
  }
}

export interface VectorMemoryIndexOptions {
  /** Embedding provider (defaults to deterministic HashEmbeddingProvider). */
  embedder?: EmbeddingProvider;
  /** Weight for semantic cosine similarity (0..1). Defaults to 0.75. */
  semanticWeight?: number;
  /** Minimum combined score threshold to return a hit. Defaults to 0.05. */
  minScore?: number;
}

interface VectorEntry {
  tenantId: string;
  scopeKey: string;
  version: string;
  text: string;
  vector: number[];
  generation: number;
}

export class VectorMemoryIndex implements MemoryIndex {
  private readonly embedder: EmbeddingProvider;
  private readonly semanticWeight: number;
  private readonly minScore: number;
  private readonly entries = new Map<string, VectorEntry>();
  private readonly tombstones = new Map<string, number>();
  private lag = 0;

  constructor(options: VectorMemoryIndexOptions = {}) {
    this.embedder = options.embedder ?? new HashEmbeddingProvider();
    this.semanticWeight = Math.min(1, Math.max(0, options.semanticWeight ?? 0.75));
    this.minScore = options.minScore ?? 0.05;
  }

  async upsert(tenantId: string, item: MemoryItem, generation = 0): Promise<void> {
    const sk = scopeKey(item.scope);
    const floor = this.tombstones.get(`${tenantId}:${sk}`) ?? 0;
    if (generation < floor) return;
    const text = `${item.structured?.key ?? ""} ${item.content}`.trim();
    const [vector = []] = await this.embedder.embed([text]);
    this.entries.set(`${tenantId}:${item.id}`, {
      tenantId,
      scopeKey: sk,
      version: item.version,
      text: text.toLowerCase(),
      vector,
      generation,
    });
  }

  async delete(tenantId: string, id: string, generation: number): Promise<void> {
    const key = `${tenantId}:${id}`;
    const entry = this.entries.get(key);
    if (entry) {
      const tk = `${tenantId}:${entry.scopeKey}`;
      this.tombstones.set(tk, Math.max(this.tombstones.get(tk) ?? 0, generation));
    }
    this.entries.delete(key);
  }

  async applyOutbox(
    tenantId: string,
    events: MemoryOutboxEvent[],
    lookup: (id: string) => Promise<MemoryItem | null>,
  ): Promise<void> {
    for (const e of events) {
      if (e.op === "delete") {
        const tk = `${tenantId}:${e.scopeKey}`;
        this.tombstones.set(tk, Math.max(this.tombstones.get(tk) ?? 0, e.generation));
        this.entries.delete(`${tenantId}:${e.itemId}`);
        continue;
      }
      const item = await lookup(e.itemId);
      if (!item) continue;
      await this.upsert(tenantId, item, e.generation);
    }
  }

  async search(
    tenantId: string,
    sk: string,
    text: string,
    maxItems: number,
  ): Promise<Array<{ id: string; version: string; score: number }>> {
    const [queryVec = []] = await this.embedder.embed([text]);
    const terms = text.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
    const lexicalWeight = 1 - this.semanticWeight;
    const out: Array<{ id: string; version: string; score: number }> = [];

    for (const [key, e] of this.entries) {
      if (e.tenantId !== tenantId || e.scopeKey !== sk) continue;
      const sem = Math.max(0, cosineSimilarity(queryVec, e.vector));
      const lex = terms.length > 0 ? terms.filter((t) => e.text.includes(t)).length / terms.length : 0;
      const score = this.semanticWeight * sem + lexicalWeight * lex;
      if (score >= this.minScore) {
        out.push({ id: key.slice(tenantId.length + 1), version: e.version, score });
      }
    }

    return out.sort((a, b) => b.score - a.score).slice(0, maxItems);
  }

  lagMs(): number {
    return this.lag;
  }
}
