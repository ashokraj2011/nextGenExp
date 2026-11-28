import { createHash } from "node:crypto";
import type { SqliteDatabase } from "@sfield/store-sqlite";
import {
  systemConfigBundleSchema,
  type SystemConfigBundle,
  type SystemConfigEntity,
  type SystemConfigKind,
  type SystemConfigRevision,
  type SystemConfigStatus,
} from "../../packages/contracts/system-config";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",") + "}";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

type EntityRow = {
  tenant_id: string;
  domain_id: string;
  kind: string;
  entity_id: string;
  label: string;
  status: string;
  revision: number;
  digest: string;
  payload_json: string;
  updated_by: string;
  updated_at: string;
};

type RevisionRow = {
  tenant_id: string;
  domain_id: string;
  kind: string;
  entity_id: string;
  revision: number;
  status: string;
  digest: string;
  payload_json: string;
  change_note: string;
  updated_by: string;
  updated_at: string;
};

function toEntity(row: EntityRow): SystemConfigEntity {
  return {
    tenantId: row.tenant_id,
    domainId: row.domain_id,
    kind: row.kind as SystemConfigKind,
    entityId: row.entity_id,
    label: row.label,
    status: row.status as SystemConfigStatus,
    revision: row.revision,
    digest: row.digest,
    payload: JSON.parse(row.payload_json) as unknown,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function toRevision(row: RevisionRow): SystemConfigRevision {
  return {
    tenantId: row.tenant_id,
    domainId: row.domain_id,
    kind: row.kind as SystemConfigKind,
    entityId: row.entity_id,
    revision: row.revision,
    status: row.status as SystemConfigStatus,
    digest: row.digest,
    payload: JSON.parse(row.payload_json) as unknown,
    changeNote: row.change_note,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/**
 * Unified tenant-scoped `system` configuration schema in SQLite (Postgres-ready DDL).
 * Stores all platform control-plane configs (smass virtual models, ER relations, sphoton field exposures,
 * integrations, task contracts, MCP exposure) with immutable revision history, rollback, and bundle export/import.
 */
export class SystemConfigStore {
  constructor(
    private readonly db: SqliteDatabase,
    readonly tenantId: string,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_entities (
        tenant_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'published',
        revision INTEGER NOT NULL DEFAULT 1,
        digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_by TEXT NOT NULL DEFAULT 'system',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, domain_id, kind, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_system_entities_tenant_kind
        ON system_entities(tenant_id, kind, domain_id);

      CREATE TABLE IF NOT EXISTS system_entity_revisions (
        tenant_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        change_note TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT 'system',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, domain_id, kind, entity_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_system_revisions_lookup
        ON system_entity_revisions(tenant_id, domain_id, kind, entity_id, revision DESC);
    `);
  }

  get(domainId: string, kind: SystemConfigKind, entityId: string): SystemConfigEntity | undefined {
    const row = this.db.one<EntityRow>(
      `SELECT * FROM system_entities WHERE tenant_id = ? AND domain_id = ? AND kind = ? AND entity_id = ?`,
      this.tenantId, domainId, kind, entityId,
    );
    return row ? toEntity(row) : undefined;
  }

  list(filter: { domainId?: string; kind?: SystemConfigKind; status?: SystemConfigStatus } = {}): SystemConfigEntity[] {
    const clauses = ["tenant_id = ?"];
    const args: string[] = [this.tenantId];
    if (filter.domainId) { clauses.push("domain_id = ?"); args.push(filter.domainId); }
    if (filter.kind) { clauses.push("kind = ?"); args.push(filter.kind); }
    if (filter.status) { clauses.push("status = ?"); args.push(filter.status); }
    const rows = this.db.all<EntityRow>(
      `SELECT * FROM system_entities WHERE ${clauses.join(" AND ")} ORDER BY kind, domain_id, entity_id`,
      ...args,
    );
    return rows.map(toEntity);
  }

  hasAny(kind: SystemConfigKind): boolean {
    const row = this.db.one<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM system_entities WHERE tenant_id = ? AND kind = ?`,
      this.tenantId, kind,
    );
    return (row?.cnt ?? 0) > 0;
  }

  hasAnyRevision(kind: SystemConfigKind): boolean {
    const row = this.db.one<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM system_entity_revisions WHERE tenant_id = ? AND kind = ?`,
      this.tenantId, kind,
    );
    return (row?.cnt ?? 0) > 0;
  }

  countRevisions(): number {
    const row = this.db.one<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM system_entity_revisions WHERE tenant_id = ?`,
      this.tenantId,
    );
    return row?.cnt ?? 0;
  }

  listRecentRevisions(limit = 30): SystemConfigRevision[] {
    const rows = this.db.all<RevisionRow>(
      `SELECT * FROM system_entity_revisions WHERE tenant_id = ? ORDER BY updated_at DESC, revision DESC LIMIT ?`,
      this.tenantId, limit,
    );
    return rows.map(toRevision);
  }

  history(domainId: string, kind: SystemConfigKind, entityId: string): SystemConfigRevision[] {
    const rows = this.db.all<RevisionRow>(
      `SELECT * FROM system_entity_revisions
       WHERE tenant_id = ? AND domain_id = ? AND kind = ? AND entity_id = ?
       ORDER BY revision DESC`,
      this.tenantId, domainId, kind, entityId,
    );
    return rows.map(toRevision);
  }

  upsert(input: {
    domainId: string;
    kind: SystemConfigKind;
    entityId: string;
    label: string;
    status?: "draft" | "published" | "deprecated";
    payload: unknown;
    updatedBy?: string;
    changeNote?: string;
  }): SystemConfigEntity {
    const status = input.status ?? "published";
    const updatedBy = input.updatedBy ?? "operator";
    const updatedAt = new Date().toISOString();
    const payloadJson = JSON.stringify(input.payload);
    const digest = sha256({ status, label: input.label, payload: input.payload });

    return this.db.tx(() => {
      const existing = this.db.one<EntityRow>(
        `SELECT * FROM system_entities WHERE tenant_id = ? AND domain_id = ? AND kind = ? AND entity_id = ?`,
        this.tenantId, input.domainId, input.kind, input.entityId,
      );
      if (existing && existing.digest === digest && existing.status === status && existing.label === input.label) {
        return toEntity(existing);
      }

      const maxRevRow = this.db.one<{ max_rev: number | null }>(
        `SELECT MAX(revision) AS max_rev FROM system_entity_revisions
         WHERE tenant_id = ? AND domain_id = ? AND kind = ? AND entity_id = ?`,
        this.tenantId, input.domainId, input.kind, input.entityId,
      );
      const nextRev = (maxRevRow?.max_rev ?? 0) + 1;
      const changeNote = input.changeNote ?? (existing ? `Updated (${status})` : `Created (${status})`);

      this.db.run(
        `INSERT INTO system_entities (tenant_id, domain_id, kind, entity_id, label, status, revision, digest, payload_json, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, domain_id, kind, entity_id) DO UPDATE SET
           label = excluded.label,
           status = excluded.status,
           revision = excluded.revision,
           digest = excluded.digest,
           payload_json = excluded.payload_json,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
        this.tenantId, input.domainId, input.kind, input.entityId, input.label, status, nextRev, digest, payloadJson, updatedBy, updatedAt,
      );

      this.db.run(
        `INSERT INTO system_entity_revisions (tenant_id, domain_id, kind, entity_id, revision, status, digest, payload_json, change_note, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.tenantId, input.domainId, input.kind, input.entityId, nextRev, status, digest, payloadJson, changeNote, updatedBy, updatedAt,
      );

      return {
        tenantId: this.tenantId,
        domainId: input.domainId,
        kind: input.kind,
        entityId: input.entityId,
        label: input.label,
        status,
        revision: nextRev,
        digest,
        payload: input.payload,
        updatedBy,
        updatedAt,
      };
    });
  }

  remove(input: {
    domainId: string;
    kind: SystemConfigKind;
    entityId: string;
    updatedBy?: string;
    changeNote?: string;
  }): boolean {
    const updatedBy = input.updatedBy ?? "operator";
    const updatedAt = new Date().toISOString();
    return this.db.tx(() => {
      const existing = this.db.one<EntityRow>(
        `SELECT * FROM system_entities WHERE tenant_id = ? AND domain_id = ? AND kind = ? AND entity_id = ?`,
        this.tenantId, input.domainId, input.kind, input.entityId,
      );
      if (!existing) return false;

      const maxRevRow = this.db.one<{ max_rev: number | null }>(
        `SELECT MAX(revision) AS max_rev FROM system_entity_revisions
         WHERE tenant_id = ? AND domain_id = ? AND kind = ? AND entity_id = ?`,
        this.tenantId, input.domainId, input.kind, input.entityId,
      );
      const nextRev = (maxRevRow?.max_rev ?? existing.revision) + 1;

      this.db.run(
        `DELETE FROM system_entities WHERE tenant_id = ? AND domain_id = ? AND kind = ? AND entity_id = ?`,
        this.tenantId, input.domainId, input.kind, input.entityId,
      );
      this.db.run(
        `INSERT INTO system_entity_revisions (tenant_id, domain_id, kind, entity_id, revision, status, digest, payload_json, change_note, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, 'deleted', ?, ?, ?, ?, ?)`,
        this.tenantId, input.domainId, input.kind, input.entityId, nextRev, existing.digest, existing.payload_json,
        input.changeNote ?? "Deleted entity", updatedBy, updatedAt,
      );
      return true;
    });
  }

  rollback(input: {
    domainId: string;
    kind: SystemConfigKind;
    entityId: string;
    targetRevision: number;
    updatedBy?: string;
  }): SystemConfigEntity {
    const revRow = this.db.one<RevisionRow>(
      `SELECT * FROM system_entity_revisions
       WHERE tenant_id = ? AND domain_id = ? AND kind = ? AND entity_id = ? AND revision = ?`,
      this.tenantId, input.domainId, input.kind, input.entityId, input.targetRevision,
    );
    if (!revRow) {
      throw new Error(`Revision ${input.targetRevision} not found for ${input.kind}:${input.entityId}.`);
    }
    if (revRow.status === "deleted") {
      throw new Error(`Revision ${input.targetRevision} is a deletion tombstone; choose an earlier revision to restore.`);
    }
    const payload = JSON.parse(revRow.payload_json) as Record<string, unknown>;
    const label = typeof payload?.label === "string"
      ? payload.label
      : typeof payload?.name === "string"
        ? payload.name
        : input.entityId;
    return this.upsert({
      domainId: input.domainId,
      kind: input.kind,
      entityId: input.entityId,
      label,
      status: revRow.status as "draft" | "published" | "deprecated",
      payload,
      updatedBy: input.updatedBy ?? "operator",
      changeNote: `Rolled back to revision ${input.targetRevision}`,
    });
  }

  exportTenantBundle(): SystemConfigBundle {
    const entities = this.list()
      .filter((e) => e.status !== "deleted")
      .map((e) => ({
        domainId: e.domainId,
        kind: e.kind,
        entityId: e.entityId,
        label: e.label,
        status: e.status as "draft" | "published" | "deprecated",
        payload: e.payload,
      }));
    const bundleDigest = sha256({ format: "cep.system.bundle@1.0.0", entities });
    return {
      format: "cep.system.bundle@1.0.0",
      tenantId: this.tenantId,
      exportedAt: new Date().toISOString(),
      bundleDigest,
      entities,
    };
  }

  importTenantBundle(rawBundle: unknown, updatedBy = "operator"): { importedCount: number; updatedKinds: SystemConfigKind[] } {
    const parsed = systemConfigBundleSchema.parse(rawBundle);
    const expectedDigest = sha256({ format: parsed.format, entities: parsed.entities });
    if (parsed.bundleDigest !== expectedDigest) {
      throw new Error("Bundle digest mismatch — the tenant config bundle may have been altered.");
    }
    const kinds = new Set<SystemConfigKind>();
    this.db.tx(() => {
      for (const item of parsed.entities) {
        kinds.add(item.kind);
        this.upsert({
          domainId: item.domainId,
          kind: item.kind,
          entityId: item.entityId,
          label: item.label,
          status: item.status,
          payload: item.payload,
          updatedBy,
          changeNote: `Imported from tenant bundle (${parsed.tenantId})`,
        });
      }
    });
    return { importedCount: parsed.entities.length, updatedKinds: [...kinds] };
  }

  schemaMetadata() {
    return {
      tables: [
        {
          name: "system_entities",
          primaryKey: ["tenant_id", "domain_id", "kind", "entity_id"],
          columns: [
            { name: "tenant_id", type: "TEXT", note: "PK · tenant isolation / Postgres RLS key" },
            { name: "domain_id", type: "TEXT", note: "PK · workspace domain (wealth, it_ops, sales_revops, tenant)" },
            { name: "kind", type: "TEXT", note: "PK · smass_virtual_model | smass_relation | sphoton_exposure | integration | task_contract | mcp_exposure" },
            { name: "entity_id", type: "TEXT", note: "PK · canonical config identifier" },
            { name: "label", type: "TEXT", note: "Human-readable name" },
            { name: "status", type: "TEXT", note: "draft | published | deprecated" },
            { name: "revision", type: "INTEGER", note: "Monotonic revision counter" },
            { name: "digest", type: "TEXT", note: "SHA-256 tamper & drift fingerprint" },
            { name: "payload_json", type: "TEXT", note: "Validated JSON configuration document" },
            { name: "updated_by", type: "TEXT", note: "Operator / system actor" },
            { name: "updated_at", type: "TEXT", note: "ISO-8601 timestamp" },
          ],
        },
        {
          name: "system_entity_revisions",
          primaryKey: ["tenant_id", "domain_id", "kind", "entity_id", "revision"],
          columns: [
            { name: "tenant_id", type: "TEXT", note: "PK/FK → system_entities.tenant_id" },
            { name: "domain_id", type: "TEXT", note: "PK/FK → system_entities.domain_id" },
            { name: "kind", type: "TEXT", note: "PK/FK → system_entities.kind" },
            { name: "entity_id", type: "TEXT", note: "PK/FK → system_entities.entity_id" },
            { name: "revision", type: "INTEGER", note: "PK · immutable version number" },
            { name: "status", type: "TEXT", note: "draft | published | deprecated | deleted" },
            { name: "digest", type: "TEXT", note: "SHA-256 snapshot digest" },
            { name: "payload_json", type: "TEXT", note: "Immutable JSON snapshot for 1-click rollback" },
            { name: "change_note", type: "TEXT", note: "Audit reason (Created / Updated / Rolled back / Imported)" },
            { name: "updated_by", type: "TEXT", note: "Actor" },
            { name: "updated_at", type: "TEXT", note: "ISO-8601 timestamp" },
          ],
        },
      ],
      mermaidEr: [
        "erDiagram",
        "  SYSTEM_ENTITIES {",
        "    string tenant_id PK",
        "    string domain_id PK",
        "    string kind PK",
        "    string entity_id PK",
        "    string label",
        "    string status",
        "    integer revision",
        "    string digest",
        "    string payload_json",
        "    string updated_by",
        "    string updated_at",
        "  }",
        "  SYSTEM_ENTITY_REVISIONS {",
        "    string tenant_id PK,FK",
        "    string domain_id PK,FK",
        "    string kind PK,FK",
        "    string entity_id PK,FK",
        "    integer revision PK",
        "    string status",
        "    string digest",
        "    string payload_json",
        "    string change_note",
        "    string updated_by",
        "    string updated_at",
        "  }",
        '  SYSTEM_ENTITIES ||--o{ SYSTEM_ENTITY_REVISIONS : "has_revision_history"',
      ].join("\n"),
    };
  }
}
