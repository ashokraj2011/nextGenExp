/**
 * PostgreSQL MemoryRepository implementation for @sfield/store-postgres (§17.5).
 */
import {
  SFieldError,
  newId,
  nowIso,
  scopeKey,
  type MemoryFilter,
  type MemoryItem,
  type MemoryKind,
  type MemoryOutboxEvent,
  type MemoryRepository,
  type MemoryScope,
  type Page,
  type PageRequest,
} from "@sfield/core";
import type { PostgresSqlClient } from "./index.js";

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(
    private readonly sql: PostgresSqlClient,
    private readonly getNamespace: () => string,
  ) {}

  async get(tenantId: string, id: string): Promise<MemoryItem | null> {
    const res = await this.sql.query<{ doc: MemoryItem }>(
      "SELECT doc FROM sfield_memory WHERE namespace = $1 AND tenant_id = $2 AND id = $3",
      [this.getNamespace(), tenantId, id],
    );
    return res.rows[0]?.doc ?? null;
  }

  async list(tenantId: string, filter: MemoryFilter, page?: PageRequest): Promise<Page<MemoryItem>> {
    const ns = this.getNamespace();
    const res = await this.sql.query<{ doc: MemoryItem }>(
      "SELECT doc FROM sfield_memory WHERE namespace = $1 AND tenant_id = $2 ORDER BY updated_at DESC",
      [ns, tenantId],
    );
    const now = Date.now();
    const kinds = filter.kind ? (Array.isArray(filter.kind) ? filter.kind : [filter.kind]) : null;
    const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
    const sk = filter.scope ? scopeKey(filter.scope) : null;
    const needle = filter.text?.toLowerCase();

    const filtered = res.rows
      .map((r) => r.doc)
      .filter((item) => {
        if (sk && scopeKey(item.scope) !== sk) return false;
        if (kinds && !kinds.includes(item.kind)) return false;
        if (statuses && !statuses.includes(item.status)) return false;
        if (filter.key && item.structured?.key !== filter.key) return false;
        if (!filter.includeExpired && Date.parse(item.expiresAt) <= now) return false;
        if (needle && !`${item.structured?.key ?? ""} ${item.content}`.toLowerCase().includes(needle)) return false;
        return true;
      });

    const limit = page?.limit ?? 100;
    const offset = page?.cursor ? Math.max(0, Number(page.cursor) || 0) : 0;
    const slice = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined;
    return { items: slice, ...(nextCursor ? { nextCursor } : {}) };
  }

  async create(tenantId: string, item: MemoryItem, idempotencyKey: string): Promise<{ item: MemoryItem; created: boolean }> {
    const ns = this.getNamespace();
    const existing = await this.sql.query<{ doc: MemoryItem }>(
      "SELECT doc FROM sfield_memory WHERE namespace = $1 AND tenant_id = $2 AND idempotency_key = $3 LIMIT 1",
      [ns, tenantId, idempotencyKey],
    );
    if (existing.rows[0]) {
      return { item: existing.rows[0].doc, created: false };
    }
    const sk = scopeKey(item.scope);
    await this.sql.query(
      "INSERT INTO sfield_memory (tenant_id, id, namespace, scope_key, kind, status, idempotency_key, expires_at, updated_at, doc) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::jsonb)",
      [tenantId, item.id, ns, sk, item.kind, item.status, idempotencyKey, item.expiresAt, item.updatedAt, JSON.stringify(item)],
    );
    const gen = await this.generation(tenantId, sk);
    const ev: MemoryOutboxEvent = { id: newId("obx"), itemId: item.id, version: item.version, scopeKey: sk, op: "upsert", generation: gen, at: nowIso() };
    await this.sql.query(
      "INSERT INTO sfield_memory_outbox (id, namespace, at, doc) VALUES ($1, $2, $3::timestamptz, $4::jsonb)",
      [ev.id, ns, ev.at, JSON.stringify(ev)],
    );
    return { item, created: true };
  }

  async update(tenantId: string, id: string, ifVersion: string, next: MemoryItem): Promise<MemoryItem> {
    const cur = await this.get(tenantId, id);
    if (!cur) throw new SFieldError("NOT_FOUND", `memory item ${id} not found`);
    if (cur.version !== ifVersion) throw new SFieldError("VERSION_CONFLICT", `memory item ${id} version mismatch`);
    const ns = this.getNamespace();
    const sk = scopeKey(next.scope);
    await this.sql.query(
      "UPDATE sfield_memory SET status = $4, expires_at = $5::timestamptz, updated_at = $6::timestamptz, doc = $7::jsonb WHERE namespace = $1 AND tenant_id = $2 AND id = $3",
      [ns, tenantId, id, next.status, next.expiresAt, next.updatedAt, JSON.stringify(next)],
    );
    const gen = await this.generation(tenantId, sk);
    const ev: MemoryOutboxEvent = { id: newId("obx"), itemId: next.id, version: next.version, scopeKey: sk, op: "upsert", generation: gen, at: nowIso() };
    await this.sql.query(
      "INSERT INTO sfield_memory_outbox (id, namespace, at, doc) VALUES ($1, $2, $3::timestamptz, $4::jsonb)",
      [ev.id, ns, ev.at, JSON.stringify(ev)],
    );
    return next;
  }

  async delete(tenantId: string, ids: string[], _idempotencyKey: string): Promise<{ generation: number; count: number }> {
    const ns = this.getNamespace();
    let count = 0;
    let maxGen = 0;
    for (const id of ids) {
      const existing = await this.get(tenantId, id);
      if (!existing) continue;
      const sk = scopeKey(existing.scope);
      const nextGen = (await this.generation(tenantId, sk)) + 1;
      maxGen = Math.max(maxGen, nextGen);
      await this.sql.query(
        "INSERT INTO sfield_memory_generations (namespace, tenant_id, scope_key, generation) VALUES ($1, $2, $3, $4) ON CONFLICT (namespace, tenant_id, scope_key) DO UPDATE SET generation = EXCLUDED.generation",
        [ns, tenantId, sk, nextGen],
      );
      await this.sql.query("DELETE FROM sfield_memory WHERE namespace = $1 AND tenant_id = $2 AND id = $3", [ns, tenantId, id]);
      const ev: MemoryOutboxEvent = { id: newId("obx"), itemId: id, version: existing.version, scopeKey: sk, op: "delete", generation: nextGen, at: nowIso() };
      await this.sql.query(
        "INSERT INTO sfield_memory_outbox (id, namespace, at, doc) VALUES ($1, $2, $3::timestamptz, $4::jsonb)",
        [ev.id, ns, ev.at, JSON.stringify(ev)],
      );
      count++;
    }
    return { generation: maxGen, count };
  }

  async generation(tenantId: string, sk: string): Promise<number> {
    const res = await this.sql.query<{ generation: number }>(
      "SELECT generation FROM sfield_memory_generations WHERE namespace = $1 AND tenant_id = $2 AND scope_key = $3",
      [this.getNamespace(), tenantId, sk],
    );
    return res.rows[0]?.generation ?? 0;
  }

  async countActive(tenantId: string, scope: MemoryScope, kind: MemoryKind): Promise<number> {
    const page = await this.list(tenantId, { scope, kind, status: "active" }, { limit: 10000 });
    return page.items.length;
  }

  async drainOutbox(max: number): Promise<MemoryOutboxEvent[]> {
    const res = await this.sql.query<{ doc: MemoryOutboxEvent }>(
      "SELECT doc FROM sfield_memory_outbox WHERE namespace = $1 ORDER BY at ASC LIMIT $2",
      [this.getNamespace(), max],
    );
    return res.rows.map((r) => r.doc);
  }

  async ackOutbox(ids: string[]): Promise<void> {
    const ns = this.getNamespace();
    for (const id of ids) {
      await this.sql.query("DELETE FROM sfield_memory_outbox WHERE namespace = $1 AND id = $2", [ns, id]);
    }
  }
}
