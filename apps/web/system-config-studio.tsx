import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  Activity,
  ArrowUp,
  CheckCircle2,
  Copy,
  Database,
  Download,
  HardDrive,
  History,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import type {
  SystemConfigBundle,
  SystemConfigEntity,
  SystemConfigKind,
  SystemConfigRevision,
  SystemCopilotCard,
} from "../../packages/contracts/system-config";
import { api, toolSetupErrorMessage } from "./api";

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  cards?: SystemCopilotCard[];
  suggestions?: string[];
  error?: boolean;
};

const QUICK_PROMPTS = [
  { label: "System catalog", prompt: "Show system catalog", Icon: HardDrive },
  { label: "System DB schema", prompt: "Show system DB schema", Icon: Database },
  { label: "Health & drift", prompt: "Show health & drift", Icon: ShieldCheck },
  { label: "Recent revisions", prompt: "Show recent revisions", Icon: History },
  { label: "Export tenant bundle", prompt: "Export tenant bundle", Icon: Download },
  { label: "Import tenant bundle", prompt: "Import tenant bundle", Icon: Upload },
];

const KIND_LABELS: Record<SystemConfigKind, string> = {
  smass_virtual_model: "smass Virtual Models",
  smass_relation: "smass ER Relations",
  sphoton_exposure: "sphoton Field Exposures",
  integration: "Integrations",
  task_contract: "Task Contracts",
  mcp_exposure: "MCP Exposure",
};

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function formatRich(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} style={{ fontSize: "0.82em", padding: "1px 5px", borderRadius: "5px", background: "var(--paper, #eef5f0)" }}>{part.slice(1, -1)}</code>;
    return <span key={i}>{part}</span>;
  });
}

function SystemCatalogCard({
  tenantId,
  entities,
  countsByKind,
  initialKind,
  onPrompt,
}: {
  tenantId: string;
  entities: SystemConfigEntity[];
  countsByKind: Record<string, number>;
  initialKind?: SystemConfigKind;
  onPrompt: (p: string) => void;
}) {
  const [kindFilter, setKindFilter] = useState<string>(initialKind ?? "all");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const visible = kindFilter === "all" ? entities : entities.filter((e) => e.kind === kindFilter);

  return (
    <section className="admin-card" aria-label="System config catalog" style={{ display: "grid", gap: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <div>
          <span style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--teal-dark)" }}>
            system_entities · tenant {tenantId}
          </span>
          <h3 style={{ margin: "2px 0 0", fontSize: "0.96rem" }}>{visible.length} configuration entit{visible.length === 1 ? "y" : "ies"}</h3>
        </div>
        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setKindFilter("all")}
            style={{
              padding: "3px 8px",
              fontSize: "0.72rem",
              background: kindFilter === "all" ? "var(--teal)" : undefined,
              color: kindFilter === "all" ? "#fff" : undefined,
            }}
          >
            All ({entities.length})
          </button>
          {(Object.entries(countsByKind) as Array<[SystemConfigKind, number]>).map(([k, cnt]) => (
            <button
              key={k}
              type="button"
              className="secondary-button"
              onClick={() => setKindFilter(k)}
              style={{
                padding: "3px 8px",
                fontSize: "0.72rem",
                background: kindFilter === k ? "var(--teal)" : undefined,
                color: kindFilter === k ? "#fff" : undefined,
              }}
            >
              {KIND_LABELS[k] ?? k} ({cnt})
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gap: "6px", maxHeight: "380px", overflowY: "auto" }}>
        {visible.map((item) => {
          const rowKey = `${item.domainId}:${item.kind}:${item.entityId}`;
          const expanded = expandedKey === rowKey;
          return (
            <div
              key={rowKey}
              style={{
                border: "1px solid var(--border, #d8e4dc)",
                borderRadius: "8px",
                padding: "8px 10px",
                background: "var(--paper, #f8faf9)",
                display: "grid",
                gap: "6px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap", fontSize: "0.8rem" }}>
                  <strong>{item.label}</strong>
                  <code style={{ fontSize: "0.74rem" }}>{item.entityId}</code>
                  <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "999px", background: "#e0f2fe", color: "#075985", fontWeight: 600 }}>
                    {item.kind}
                  </span>
                  <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "999px", background: "#f1f5f9", color: "#334155", fontWeight: 600 }}>
                    {item.domainId}
                  </span>
                  <span
                    style={{
                      fontSize: "0.68rem",
                      padding: "1px 6px",
                      borderRadius: "999px",
                      fontWeight: 700,
                      background: item.status === "published" ? "#dcfce7" : "#fef3c7",
                      color: item.status === "published" ? "#155331" : "#92400e",
                    }}
                  >
                    {item.status} · rev #{item.revision}
                  </span>
                  <code style={{ fontSize: "0.68rem", color: "var(--muted)" }}>{item.digest.slice(0, 8)}</code>
                </div>
                <div style={{ display: "inline-flex", gap: "5px" }}>
                  <button
                    type="button"
                    className="secondary-button"
                    style={{ padding: "2px 8px", fontSize: "0.71rem" }}
                    onClick={() => setExpandedKey(expanded ? null : rowKey)}
                  >
                    {expanded ? "Hide JSON" : "Inspect JSON"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    style={{ padding: "2px 8px", fontSize: "0.71rem", display: "inline-flex", alignItems: "center", gap: "3px" }}
                    onClick={() => onPrompt(`Show history for ${item.entityId}`)}
                  >
                    <History size={11} /> History
                  </button>
                </div>
              </div>
              {expanded && (
                <pre style={{ margin: 0, padding: "8px", borderRadius: "6px", background: "#0f172a", color: "#e2e8f0", fontSize: "0.72rem", overflowX: "auto", maxHeight: "220px" }}>
                  {JSON.stringify(item.payload, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SystemHistoryCard({
  domainId,
  entityKind,
  entityId,
  revisions: initialRevisions,
  onPrompt,
}: {
  domainId: string;
  entityKind: SystemConfigKind;
  entityId: string;
  revisions: SystemConfigRevision[];
  onPrompt: (p: string) => void;
}) {
  const [revisions, setRevisions] = useState(initialRevisions);
  const [busyRev, setBusyRev] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function doRollback(rev: SystemConfigRevision) {
    setBusyRev(rev.revision);
    setError("");
    setNotice("");
    try {
      const out = await api.systemConfigRollback({
        domainId: rev.domainId,
        kind: rev.kind,
        entityId: rev.entityId,
        targetRevision: rev.revision,
      });
      setRevisions(out.revisions);
      setNotice(`Rolled back ${rev.entityId} to revision #${rev.revision} → new active revision #${out.entity.revision} (runtime hot-reloaded).`);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusyRev(null);
    }
  }

  return (
    <section className="admin-card" aria-label="Revision history" style={{ display: "grid", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <span style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", color: "var(--teal-dark)" }}>
            system_entity_revisions · {entityKind} · {domainId}
          </span>
          <h3 style={{ margin: "2px 0 0", fontSize: "0.95rem" }}>{entityId}</h3>
        </div>
        <button type="button" className="secondary-button" style={{ padding: "3px 8px", fontSize: "0.72rem" }} onClick={() => onPrompt("Show system catalog")}>
          Back to catalog
        </button>
      </div>
      {notice && <p role="status" style={{ margin: 0, fontSize: "0.78rem", color: "#155331", fontWeight: 600 }}>{notice}</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
      <div style={{ display: "grid", gap: "6px" }}>
        {revisions.map((rev, idx) => (
          <div
            key={`${rev.domainId}:${rev.kind}:${rev.entityId}:${rev.revision}`}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
              padding: "7px 10px",
              borderRadius: "8px",
              border: "1px solid var(--border, #d8e4dc)",
              background: idx === 0 ? "#f0fdf4" : "var(--paper, #f8faf9)",
              fontSize: "0.78rem",
            }}
          >
            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              <strong>rev #{rev.revision}</strong>
              {entityId === "Recent Tenant Revisions" && <code>{rev.entityId}</code>}
              <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "999px", background: "#e2e8f0", color: "#1e293b", fontWeight: 600 }}>
                {rev.status}
              </span>
              <span style={{ color: "var(--muted)" }}>{rev.changeNote}</span>
              <code style={{ fontSize: "0.7rem", color: "var(--muted)" }}>{rev.digest.slice(0, 8)}</code>
              <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>by {rev.updatedBy}</span>
            </div>
            {rev.status !== "deleted" && (
              <button
                type="button"
                className="secondary-button"
                disabled={busyRev === rev.revision}
                onClick={() => void doRollback(rev)}
                style={{ padding: "3px 8px", fontSize: "0.71rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
              >
                <RotateCcw size={11} /> {busyRev === rev.revision ? "Rolling back…" : "Restore rev #" + rev.revision}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function SystemBundleCard({
  bundle,
  mode,
  onPrompt,
}: {
  bundle: SystemConfigBundle;
  mode: "export" | "import";
  onPrompt: (p: string) => void;
}) {
  const [jsonText, setJsonText] = useState(mode === "export" ? JSON.stringify(bundle, null, 2) : "");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function downloadBundle() {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bundle.tenantId}-system-bundle.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function runImport(raw: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const parsed = JSON.parse(raw) as SystemConfigBundle;
      const out = await api.systemConfigImport(parsed);
      setNotice(`Imported ${out.importedCount} config entities (${out.updatedKinds.join(", ")}) and hot-reloaded the live runtime.`);
    } catch (e) {
      setError(toolSetupErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    void f.text().then((content) => setJsonText(content));
  }

  return (
    <section className="admin-card" aria-label="Tenant config bundle" style={{ display: "grid", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <div>
          <span style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", color: "var(--teal-dark)" }}>
            {bundle.format} · SHA-256 {bundle.bundleDigest.slice(0, 12)}
          </span>
          <h3 style={{ margin: "2px 0 0", fontSize: "0.95rem" }}>
            {mode === "export" ? `Tenant Export (${bundle.entities.length} entities)` : "Import Tenant Config Bundle"}
          </h3>
        </div>
        <div style={{ display: "inline-flex", gap: "6px" }}>
          {mode === "export" ? (
            <>
              <button type="button" className="secondary-button" style={{ padding: "4px 9px", fontSize: "0.74rem", display: "inline-flex", alignItems: "center", gap: "4px" }} onClick={downloadBundle}>
                <Download size={12} /> Download .json
              </button>
              <button
                type="button"
                className="secondary-button"
                style={{ padding: "4px 9px", fontSize: "0.74rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                onClick={() => {
                  void navigator.clipboard.writeText(jsonText);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Copy size={12} /> {copied ? "Copied" : "Copy"}
              </button>
            </>
          ) : (
            <>
              <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={handleFile} />
              <button type="button" className="secondary-button" style={{ padding: "4px 9px", fontSize: "0.74rem", display: "inline-flex", alignItems: "center", gap: "4px" }} onClick={() => fileRef.current?.click()}>
                <Upload size={12} /> Upload .json bundle
              </button>
            </>
          )}
        </div>
      </div>

      {mode === "export" ? (
        <pre style={{ margin: 0, padding: "10px", borderRadius: "8px", background: "#0f172a", color: "#e2e8f0", fontSize: "0.72rem", maxHeight: "260px", overflow: "auto" }}>
          {jsonText}
        </pre>
      ) : (
        <>
          <textarea
            rows={7}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='Paste exported cep.system.bundle@1.0.0 JSON or upload a .json file above…'
            style={{ width: "100%", fontFamily: "monospace", fontSize: "0.74rem", padding: "8px", borderRadius: "8px", border: "1px solid var(--border)" }}
          />
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !jsonText.trim()}
              onClick={() => void runImport(jsonText)}
              style={{ padding: "5px 12px", fontSize: "0.78rem", background: "var(--teal)", color: "#fff", borderColor: "var(--teal)", fontWeight: 600 }}
            >
              {busy ? "Importing…" : "Verify Digest & Import"}
            </button>
            <button type="button" className="secondary-button" style={{ padding: "5px 9px", fontSize: "0.75rem" }} onClick={() => onPrompt("Show system catalog")}>
              View catalog
            </button>
          </div>
        </>
      )}
      {notice && <p role="status" style={{ margin: 0, fontSize: "0.78rem", color: "#155331", fontWeight: 600 }}>{notice}</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
    </section>
  );
}

export function SystemConfigStudio() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setInput("");
    const nowLabel = timeFmt.format(new Date());
    setMessages((prev) => [...prev, { id: `u_${Date.now()}`, role: "user", text: msg, at: nowLabel }]);
    setBusy(true);
    try {
      const res = await api.systemCopilot(msg);
      setMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: "assistant",
          text: res.reply,
          at: timeFmt.format(new Date()),
          cards: res.cards,
          suggestions: res.suggestedPrompts,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          role: "assistant",
          text: toolSetupErrorMessage(e),
          at: timeFmt.format(new Date()),
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void send("Show system catalog");
  }, []);

  useEffect(() => {
    if (messages.length > 2 && threadRef.current) {
      threadRef.current.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, busy]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <main
      className="admin-page"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        maxWidth: "1180px",
        width: "100%",
        height: "calc(100vh - 54px)",
        margin: "0 auto",
        padding: "16px 18px 14px",
        overflow: "hidden",
      }}
    >
      <header style={{ flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--teal-dark)", textTransform: "uppercase", letterSpacing: "0.04em", display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <HardDrive size={13} aria-hidden="true" />
            Unified Control-Plane DB Schema · system_entities &amp; system_entity_revisions
          </span>
          <h1 style={{ margin: "2px 0 4px", fontSize: "1.45rem" }}>System Config Studio</h1>
          <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--muted)" }}>
            Configure, inspect, roll back, and promote all tenant configurations stored in the unified <code>system</code> DB schema — using the exact same chat + interactive card experience.
          </p>
        </div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {QUICK_PROMPTS.map(({ label, prompt, Icon }) => (
            <button
              key={label}
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void send(prompt)}
              style={{ padding: "5px 10px", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "5px" }}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </header>

      <div
        ref={threadRef}
        data-testid="system-config-thread"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          paddingRight: "4px",
        }}
      >
        {messages.map((m) => (
          <div key={m.id} style={{ display: "grid", gap: "8px", justifyItems: m.role === "user" ? "end" : "stretch" }}>
            <div
              style={{
                maxWidth: m.role === "user" ? "70%" : "100%",
                padding: "9px 13px",
                borderRadius: "12px",
                background: m.role === "user" ? "var(--teal)" : m.error ? "#fef2f2" : "var(--surface, #fff)",
                color: m.role === "user" ? "#fff" : m.error ? "#991b1b" : "var(--ink)",
                border: m.role === "user" ? "none" : "1px solid var(--border, #d8e4dc)",
                fontSize: "0.85rem",
              }}
            >
              <div style={{ fontSize: "0.7rem", opacity: 0.75, marginBottom: "2px" }}>
                {m.role === "user" ? "You" : "System Config Copilot"} · {m.at}
              </div>
              <div>{formatRich(m.text)}</div>
            </div>

            {m.cards?.map((card, idx) => {
              if (card.kind === "system_catalog") {
                return (
                  <SystemCatalogCard
                    key={idx}
                    tenantId={card.tenantId}
                    entities={card.entities}
                    countsByKind={card.countsByKind}
                    initialKind={card.filterKind}
                    onPrompt={(p) => void send(p)}
                  />
                );
              }
              if (card.kind === "system_history") {
                return (
                  <SystemHistoryCard
                    key={idx}
                    domainId={card.domainId}
                    entityKind={card.entityKind}
                    entityId={card.entityId}
                    revisions={card.revisions}
                    onPrompt={(p) => void send(p)}
                  />
                );
              }
              if (card.kind === "system_bundle") {
                return <SystemBundleCard key={idx} bundle={card.bundle} mode={card.mode} onPrompt={(p) => void send(p)} />;
              }
              if (card.kind === "system_schema") {
                return (
                  <section key={idx} className="admin-card" aria-label="System DB schema" style={{ display: "grid", gap: "10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      <strong style={{ fontSize: "0.92rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <Database size={15} color="var(--teal)" />
                        Unified `system` DB Schema ({card.totalEntities} entities · {card.totalRevisions} revisions)
                      </strong>
                      <span style={{ fontSize: "0.73rem", color: "var(--muted)" }}>Tenant-partitioned · Postgres RLS ready</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                      {card.tables.map((t) => (
                        <div key={t.name} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "10px", background: "var(--paper)" }}>
                          <strong style={{ fontFamily: "monospace", fontSize: "0.82rem" }}>{t.name}</strong>
                          <div style={{ fontSize: "0.7rem", color: "var(--muted)", margin: "2px 0 6px" }}>
                            PK: <code>({t.primaryKey.join(", ")})</code>
                          </div>
                          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "3px", fontSize: "0.73rem" }}>
                            {t.columns.map((c) => (
                              <li key={c.name} style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
                                <span><code>{c.name}</code> <span style={{ color: "var(--muted)" }}>{c.type}</span></span>
                                <span style={{ color: "var(--muted)", fontSize: "0.69rem", textAlign: "right" }}>{c.note}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                    <pre style={{ margin: 0, padding: "10px", borderRadius: "8px", background: "#0f172a", color: "#e2e8f0", fontSize: "0.73rem", overflowX: "auto" }}>
                      {card.mermaidEr}
                    </pre>
                  </section>
                );
              }
              if (card.kind === "system_health") {
                return (
                  <section key={idx} className="admin-card" aria-label="System health" style={{ display: "grid", gap: "8px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <Activity size={15} color={card.driftCount === 0 ? "#15803d" : "#dc2626"} />
                        Tenant Health &amp; Schema Drift ({card.tenantId})
                      </strong>
                      <span style={{ fontSize: "0.74rem", padding: "2px 8px", borderRadius: "999px", fontWeight: 700, background: card.driftCount === 0 ? "#dcfce7" : "#fee2e2", color: card.driftCount === 0 ? "#155331" : "#991b1b" }}>
                        {card.driftCount === 0 ? "0 drift · Healthy" : `${card.driftCount} drift issue(s)`}
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px" }}>
                      {card.domains.map((d) => (
                        <div key={d.domainId} style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--paper)", fontSize: "0.78rem" }}>
                          <strong>{d.domainId}</strong>
                          <div style={{ color: "var(--muted)", fontSize: "0.73rem" }}>
                            {d.entityCount} smass entities · {d.publishedVirtualTools} live virtual tool(s)
                          </div>
                        </div>
                      ))}
                    </div>
                    {card.driftIssues.length > 0 && (
                      <ul style={{ margin: 0, paddingLeft: "18px", color: "#991b1b", fontSize: "0.78rem" }}>
                        {card.driftIssues.map((d, i) => <li key={i}><code>{d.modelId}</code>: {d.message}</li>)}
                      </ul>
                    )}
                  </section>
                );
              }
              return null;
            })}

            {m.suggestions && m.suggestions.length > 0 && (
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {m.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="secondary-button"
                    onClick={() => void send(s)}
                    style={{ padding: "3px 9px", fontSize: "0.73rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                  >
                    <Sparkles size={11} /> {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Chat Composer */}
      <div
        className="admin-card"
        style={{
          flexShrink: 0,
          display: "flex",
          gap: "8px",
          alignItems: "flex-end",
          padding: "10px",
          boxShadow: "0 4px 16px rgba(15, 36, 23, 0.08)",
        }}
      >
        <textarea
          rows={1}
          aria-label="Ask System Config Copilot"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder='Ask System Config Copilot (e.g. "Show system DB schema", "Show history for wealth.advisor_brief", "Rollback ... to revision 1", "Export tenant bundle")…'
          style={{
            flex: 1,
            resize: "none",
            border: "1px solid var(--border, #cbd5e1)",
            borderRadius: "8px",
            padding: "8px 10px",
            fontSize: "0.84rem",
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !input.trim()}
          onClick={() => void send()}
          style={{
            padding: "8px 14px",
            background: "var(--teal)",
            color: "#fff",
            borderColor: "var(--teal)",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
          }}
        >
          <CheckCircle2 size={14} style={{ display: busy ? "inline" : "none" }} />
          <ArrowUp size={15} style={{ display: busy ? "none" : "inline" }} />
          {busy ? "Working…" : "Send"}
        </button>
      </div>
    </main>
  );
}
