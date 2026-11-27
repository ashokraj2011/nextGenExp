/**
 * Durable filesystem ArtifactStore for @sfield/core (§17.4).
 *
 * Stores binary artifacts under `<rootDir>/<safeTenant>/<artifactId>.bin` with
 * companion metadata JSON, atomic temp-file writes, SHA-256 integrity checks on read,
 * tenant isolation, and optional garbage collection for uncommitted uploads.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactRef, DataClassification } from "../types/common.js";
import type { ArtifactStore } from "../types/persistence.js";
import { SFieldError } from "../errors.js";
import { digestBytes, newId, nowIso } from "../util/digest.js";

export interface FilesystemArtifactStoreOptions {
  /** Root directory on disk where tenant-scoped artifact blobs and metadata are stored. */
  rootDir: string;
}

interface ArtifactMeta {
  ref: ArtifactRef;
  tenantId: string;
  runId?: string;
  committed: boolean;
  createdAt: string;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
}

function atomicWrite(filePath: string, data: Uint8Array | string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

export class FilesystemArtifactStore implements ArtifactStore {
  private readonly rootDir: string;

  constructor(opts: FilesystemArtifactStoreOptions) {
    this.rootDir = resolve(opts.rootDir);
    mkdirSync(this.rootDir, { recursive: true });
  }

  private tenantDir(tenantId: string): string {
    const dir = join(this.rootDir, safeSegment(tenantId));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private paths(tenantId: string, id: string): { bin: string; meta: string } {
    const dir = this.tenantDir(tenantId);
    const safeId = safeSegment(id);
    return {
      bin: join(dir, `${safeId}.bin`),
      meta: join(dir, `${safeId}.meta.json`),
    };
  }

  async put(input: {
    bytes: Uint8Array;
    mediaType: string;
    classification: DataClassification;
    tenantId: string;
    runId?: string;
  }): Promise<ArtifactRef> {
    const ref: ArtifactRef = {
      id: newId("art"),
      digest: digestBytes(input.bytes),
      bytes: input.bytes.byteLength,
      mediaType: input.mediaType,
      classification: input.classification,
    };
    const { bin, meta } = this.paths(input.tenantId, ref.id);
    const record: ArtifactMeta = {
      ref,
      tenantId: input.tenantId,
      ...(input.runId ? { runId: input.runId } : {}),
      committed: false,
      createdAt: nowIso(),
    };
    atomicWrite(bin, input.bytes);
    atomicWrite(meta, JSON.stringify(record, null, 2));
    return ref;
  }

  async commit(ref: ArtifactRef, opts: { tenantId: string; runId?: string }): Promise<void> {
    const { meta } = this.paths(opts.tenantId, ref.id);
    if (!existsSync(meta)) return;
    const record = JSON.parse(readFileSync(meta, "utf8")) as ArtifactMeta;
    if (record.tenantId !== opts.tenantId) return;
    record.committed = true;
    if (opts.runId) record.runId = opts.runId;
    atomicWrite(meta, JSON.stringify(record, null, 2));
  }

  async get(ref: ArtifactRef, opts: { tenantId: string; maxBytes: number }): Promise<Uint8Array> {
    const { bin, meta } = this.paths(opts.tenantId, ref.id);
    if (!existsSync(bin) || !existsSync(meta)) {
      throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} is not available`);
    }
    const record = JSON.parse(readFileSync(meta, "utf8")) as ArtifactMeta;
    if (record.tenantId !== opts.tenantId) {
      throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} is not available`);
    }
    const bytes = new Uint8Array(readFileSync(bin));
    if (bytes.byteLength > opts.maxBytes) {
      throw new SFieldError("REQUEST_TOO_LARGE", `artifact ${ref.id} exceeds ${opts.maxBytes} bytes`);
    }
    const actualDigest = digestBytes(bytes);
    if (actualDigest !== ref.digest || record.ref.digest !== ref.digest) {
      throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} digest mismatch`);
    }
    return bytes;
  }

  async delete(ref: ArtifactRef, opts: { tenantId: string }): Promise<void> {
    const { bin, meta } = this.paths(opts.tenantId, ref.id);
    if (existsSync(bin)) rmSync(bin, { force: true });
    if (existsSync(meta)) rmSync(meta, { force: true });
  }

  /** Garbage-collects uncommitted artifacts older than `maxAgeMs`. */
  async gcUncommitted(maxAgeMs: number): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    if (!existsSync(this.rootDir)) return 0;
    for (const tenantEntry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!tenantEntry.isDirectory()) continue;
      const tDir = join(this.rootDir, tenantEntry.name);
      for (const file of readdirSync(tDir)) {
        if (!file.endsWith(".meta.json")) continue;
        const metaPath = join(tDir, file);
        try {
          const rec = JSON.parse(readFileSync(metaPath, "utf8")) as ArtifactMeta;
          if (!rec.committed && Date.parse(rec.createdAt) <= cutoff) {
            rmSync(metaPath, { force: true });
            rmSync(metaPath.replace(/\.meta\.json$/, ".bin"), { force: true });
            removed++;
          }
        } catch {
          // Ignore malformed sidecars during GC.
        }
      }
    }
    return removed;
  }
}
