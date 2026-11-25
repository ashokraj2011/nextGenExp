import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DomainWriteAuditEntry } from "../../packages/contracts/api";
import { makeId } from "../../packages/experience/compile";

export class WriteAuditStore {
  private readonly filePath: string;
  private entries: DomainWriteAuditEntry[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "write-audit.json");
    this.entries = this.load();
  }

  private load(): DomainWriteAuditEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as DomainWriteAuditEntry[]) : [];
    } catch {
      return [];
    }
  }

  private save(next: DomainWriteAuditEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf8");
    this.entries = next;
  }

  record(input: Omit<DomainWriteAuditEntry, "auditId" | "createdAt">): DomainWriteAuditEntry {
    const entry: DomainWriteAuditEntry = {
      ...input,
      auditId: makeId("audit"),
      createdAt: new Date().toISOString(),
    };
    const next = [entry, ...this.entries].slice(0, 200);
    this.save(next);
    return entry;
  }

  list(): DomainWriteAuditEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
}
