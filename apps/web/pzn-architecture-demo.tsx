import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Database,
  GitBranch,
  Layers,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import type {
  CcreSharedRule,
  PznDecisionPlaneState,
  PznDecisionRecord,
  PznDemoContextId,
} from "../server/pzn-decision-plane";
import { ThemeToggle } from "./theme";
import "./pzn-architecture-demo.css";

type ScenarioPreset = {
  id: string;
  title: string;
  subtitle: string;
  mid: string;
  context: PznDemoContextId;
  badge: string;
};

const SCENARIOS: ScenarioPreset[] = [
  {
    id: "marcus-address",
    title: "Marcus · Address Update",
    subtitle: "Dual placement: address help + shared first_deposit workflow",
    mid: "DEMO-MID-1003",
    context: "address-update",
    badge: "Dual Placement",
  },
  {
    id: "marcus-pending",
    title: "Marcus · Pending Actions",
    subtitle: "Reuses the exact same first_deposit rule (edit once)",
    mid: "DEMO-MID-1003",
    context: "pending-actions",
    badge: "Shared Rule",
  },
  {
    id: "alice-balance",
    title: "Alice · Balance Summary",
    subtitle: "1x smass snapshot (bal_17) reused across CCRE & Resolver",
    mid: "DEMO-MID-1001",
    context: "balance",
    badge: "Zero Drift",
  },
  {
    id: "alice-portsum",
    title: "Alice · Portfolio Cash",
    subtitle: "Cash > $10k triggers investing workflow on same bal_17",
    mid: "DEMO-MID-1001",
    context: "portsum",
    badge: "Relational Rule",
  },
];

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string; error?: string }).message || (data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export function PznArchitectureDemo({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<PznDecisionPlaneState | null>(null);
  const [activeDecision, setActiveDecision] = useState<PznDecisionRecord | null>(null);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>("marcus-address");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "info" | "success" | "warn" | "error"; text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"trace" | "smass" | "ranking" | "payload">("trace");

  const runScenario = useCallback(async (scenario: ScenarioPreset, silent = false) => {
    setSelectedScenarioId(scenario.id);
    setBusy(true);
    if (!silent) setBanner(null);
    try {
      const data = await apiJson<{ decision: PznDecisionRecord; state: PznDecisionPlaneState }>("/api/pzn-demo/decide", {
        method: "POST",
        body: JSON.stringify({ mid: scenario.mid, context: scenario.context, trigger: "chat_request" }),
      });
      setState(data.state);
      setActiveDecision(data.decision);
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void runScenario(SCENARIOS[0], true);
  }, [runScenario]);

  const executeWorkflow = async (tamper = false) => {
    if (!activeDecision || activeDecision.placements.nextAction?.kind !== "workflow") return;
    setBusy(true);
    setBanner(null);
    try {
      const token = tamper
        ? `${activeDecision.placements.nextAction.signedActionToken.slice(0, -4)}XXXX`
        : activeDecision.placements.nextAction.signedActionToken;
      const data = await apiJson<{ decision: PznDecisionRecord; state: PznDecisionPlaneState }>("/api/pzn-demo/execute", {
        method: "POST",
        body: JSON.stringify({
          decisionId: activeDecision.decisionId,
          mid: activeDecision.mid,
          signedActionToken: token,
        }),
      });
      setState(data.state);
      setActiveDecision(data.decision);
      setBanner({
        kind: "success",
        text: `sfield verified HMAC signature and ran 3 deterministic tools under ${data.decision.workflowExecutions.at(-1)?.turnRef}.`,
      });
    } catch (err) {
      setBanner({
        kind: tamper ? "warn" : "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmFunding = async (simulateStaleVersion = false) => {
    if (!activeDecision) return;
    setBusy(true);
    setBanner(null);
    try {
      const data = await apiJson<
        | { status: "refreshed"; decision: PznDecisionRecord; state: PznDecisionPlaneState }
        | { status: "retry_required"; message: string; state: PznDecisionPlaneState }
      >("/api/pzn-demo/confirm-funding", {
        method: "POST",
        body: JSON.stringify({
          decisionId: activeDecision.decisionId,
          mid: activeDecision.mid,
          simulateStaleVersion,
        }),
      });
      setState(data.state);
      if (data.status === "retry_required") {
        setBanner({ kind: "warn", text: data.message });
      } else {
        setActiveDecision(data.decision);
        setBanner({
          kind: "success",
          text: `funding.confirmed applied -> TS emitted revision ${data.decision.revision} (nextAction cleared live & Ranking outcome recorded).`,
        });
      }
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const toggleRule = async (rule: CcreSharedRule) => {
    setBusy(true);
    setBanner(null);
    try {
      const data = await apiJson<{ rule: CcreSharedRule; state: PznDecisionPlaneState }>("/api/pzn-demo/rule", {
        method: "POST",
        body: JSON.stringify({ ruleId: rule.ruleId, enabled: !rule.enabled }),
      });
      setState(data.state);
      const current = SCENARIOS.find((s) => s.id === selectedScenarioId) ?? SCENARIOS[0];
      await runScenario(current, true);
      setBanner({
        kind: "info",
        text: `Shared rule "${rule.ruleId}" ${data.rule.enabled ? "enabled" : "disabled"} once -> updated across ${rule.contexts.join(" & ")}.`,
      });
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const testInvalidRule = async () => {
    setBusy(true);
    setBanner(null);
    try {
      await apiJson("/api/pzn-demo/rule", {
        method: "POST",
        body: JSON.stringify({ ruleId: "first_deposit", value: "bogus_status" }),
      });
    } catch (err) {
      setBanner({
        kind: "warn",
        text: `smass Schema Guard blocked bad rule publish: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const resetAll = async () => {
    setBusy(true);
    setBanner(null);
    try {
      const data = await apiJson<{ state: PznDecisionPlaneState }>("/api/pzn-demo/reset", { method: "POST" });
      setState(data.state);
      await runScenario(SCENARIOS[0], true);
      setBanner({ kind: "info", text: "Demo reset: Marcus restored to unfunded (accountVersion 41) and all shared rules re-enabled." });
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const activeMember = state?.personas.find((p) => p.mid === activeDecision?.mid);
  const latestWorkflow = activeDecision?.workflowExecutions.at(-1);

  return (
    <div className={"pzn-arch-page" + (embedded ? " is-embedded" : "")}>
      {embedded ? (
        <div className="pzn-arch-embedded-bar">
          <div>
            <span className="pzn-arch-eyebrow">
              <Sparkles size={12} aria-hidden="true" />
              SFIELD PLUGGABLE TOOL · pzn.treatments.decide@1.0.0
            </span>
            <h2>PZN Decision Plane Sandbox</h2>
          </div>
          <div className="pzn-arch-topbar-right">
            <a href="/pzn-architecture" className="pzn-arch-back">
              Full page
            </a>
            <button type="button" className="pzn-arch-btn-secondary" disabled={busy} onClick={() => void resetAll()}>
              <RotateCcw size={14} aria-hidden="true" />
              Reset Demo
            </button>
          </div>
        </div>
      ) : (
        <header className="pzn-arch-topbar">
          <div className="pzn-arch-topbar-left">
            <a href="/" className="pzn-arch-back">
              <ArrowLeft size={15} aria-hidden="true" />
              Back to Chat
            </a>
            <div className="pzn-arch-title-group">
              <span className="pzn-arch-eyebrow">
                <Sparkles size={12} aria-hidden="true" />
                LIVE ARCHITECTURE SHOWCASE
              </span>
              <h1>PZN Agentic Decision Plane — Powered by smass &amp; sfield</h1>
            </div>
          </div>
          <div className="pzn-arch-topbar-right">
            <a href="/experience-composer" className="pzn-arch-back">
              <Layers size={14} aria-hidden="true" />
              Experience Composer
            </a>
            <button type="button" className="pzn-arch-btn-secondary" disabled={busy} onClick={() => void resetAll()}>
              <RotateCcw size={14} aria-hidden="true" />
              Reset Demo
            </button>
            <ThemeToggle compact />
          </div>
        </header>
      )}

      <main className="pzn-arch-main">
        {/* Executive Value Strip */}
        <section className="pzn-arch-kpi-strip" aria-label="Architecture guarantees">
          <div className="pzn-kpi-card">
            <div className="pzn-kpi-icon"><Database size={16} /></div>
            <div>
              <div className="pzn-kpi-label">Data Agg Reads / Decision</div>
              <div className="pzn-kpi-value">{activeDecision?.dataAggCalls ?? 1}x <span className="pzn-kpi-pill">Zero Drift</span></div>
            </div>
          </div>
          <div className="pzn-kpi-card">
            <div className="pzn-kpi-icon"><Layers size={16} /></div>
            <div>
              <div className="pzn-kpi-label">smass Customer 360 Schema</div>
              <div className="pzn-kpi-value">{state?.smassValidationIssues ?? 0} Issues <span className="pzn-kpi-pill">Closed Schema</span></div>
            </div>
          </div>
          <div className="pzn-kpi-card">
            <div className="pzn-kpi-icon"><ShieldCheck size={16} /></div>
            <div>
              <div className="pzn-kpi-label">Decision Ledger Revision</div>
              <div className="pzn-kpi-value">
                Rev {activeDecision?.revision ?? 1}{" "}
                <span className="pzn-kpi-mono">#{activeDecision?.ledgerHash ?? "—"}</span>
              </div>
            </div>
          </div>
          <div className="pzn-kpi-card">
            <div className="pzn-kpi-icon"><Lock size={16} /></div>
            <div>
              <div className="pzn-kpi-label">sfield Action Governance</div>
              <div className="pzn-kpi-value">HMAC-SHA256 <span className="pzn-kpi-pill">Decision-Bound</span></div>
            </div>
          </div>
        </section>

        {banner && (
          <div className={`pzn-arch-banner is-${banner.kind}`} role="status">
            {banner.kind === "warn" || banner.kind === "error" ? <ShieldAlert size={16} /> : <CheckCircle2 size={16} />}
            <span>{banner.text}</span>
          </div>
        )}

        <div className="pzn-arch-grid">
          {/* Left Rail: Pilot Scenarios + Shared CCRE Rules */}
          <aside className="pzn-arch-rail">
            <section className="pzn-panel">
              <div className="pzn-panel-head">
                <h2>1. Run Pilot Scenario</h2>
                <span className="pzn-panel-hint">TS Dual Policy</span>
              </div>
              <div className="pzn-scenario-list">
                {SCENARIOS.map((scenario) => (
                  <button
                    key={scenario.id}
                    type="button"
                    disabled={busy}
                    className={"pzn-scenario-btn" + (selectedScenarioId === scenario.id ? " is-active" : "")}
                    onClick={() => void runScenario(scenario)}
                  >
                    <div className="pzn-scenario-top">
                      <strong>{scenario.title}</strong>
                      <span className="pzn-mini-badge">{scenario.badge}</span>
                    </div>
                    <p>{scenario.subtitle}</p>
                  </button>
                ))}
              </div>
            </section>

            <section className="pzn-panel">
              <div className="pzn-panel-head">
                <h2>2. Shared CCRE Rules</h2>
                <span className="pzn-panel-hint">smass-Validated</span>
              </div>
              <div className="pzn-rule-list">
                {state?.rules.map((rule) => (
                  <div key={rule.ruleId} className="pzn-rule-row">
                    <div className="pzn-rule-copy">
                      <div className="pzn-rule-title">
                        <strong>{rule.label}</strong>
                        <code>{rule.ruleId}</code>
                      </div>
                      <div className="pzn-rule-expr">
                        customer_360.{rule.field} {rule.op} {String(rule.value)}
                      </div>
                      <div className="pzn-rule-contexts">
                        Contexts: {rule.contexts.join(", ")}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      className={"pzn-toggle-pill" + (rule.enabled ? " is-on" : "")}
                      onClick={() => void toggleRule(rule)}
                    >
                      {rule.enabled ? "Active" : "Paused"}
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="pzn-arch-btn-outline" disabled={busy} onClick={() => void testInvalidRule()}>
                <ShieldAlert size={14} aria-hidden="true" />
                Test Invalid Enum Rule (smass Rejects)
              </button>
            </section>
          </aside>

          {/* Main Workspace: Live Channel Preview + Architecture Inspector */}
          <section className="pzn-arch-workspace">
            {/* Live Simulated Channel + sfield Execution + Live Refresh */}
            <div className="pzn-panel pzn-channel-stage">
              <div className="pzn-panel-head">
                <div>
                  <h2>Live Channel Experience ({activeDecision?.displayName ?? "—"} · {activeDecision?.mid ?? "—"})</h2>
                  <p className="pzn-panel-sub">
                    Snapshot <code>{activeDecision?.snapshotId ?? "—"}</code> · Account v{activeMember?.accountVersion ?? "—"} ·{" "}
                    Status <strong>{activeMember?.fundingStatus ?? "—"}</strong> · Balance{" "}
                    <strong>{activeMember ? formatCents(activeMember.availableBalanceCents) : "—"}</strong>
                  </p>
                </div>
                <span className="pzn-rev-badge">
                  {activeDecision?.decisionId} · rev {activeDecision?.revision ?? 1}
                </span>
              </div>

              <div className="pzn-placements-grid">
                {/* Primary Placement */}
                <article className="pzn-placement-card">
                  <div className="pzn-placement-kicker">PRIMARY PLACEMENT · REQUESTED TASK</div>
                  {activeDecision?.placements.primary ? (
                    <>
                      <h3>{activeDecision.placements.primary.title}</h3>
                      <p>{activeDecision.placements.primary.summary}</p>
                      <div className="pzn-placement-meta">
                        <span>Kind: <strong>{activeDecision.placements.primary.kind}</strong></span>
                        <span>ID: <code>{activeDecision.placements.primary.id}</code></span>
                      </div>
                      {activeDecision.placements.primary.kind === "content" && (
                        <div className="pzn-metric-pair">
                          {"availableCents" in activeDecision.placements.primary.card && (
                            <div>
                              <span>Available</span>
                              <strong>{formatCents(Number(activeDecision.placements.primary.card.availableCents))}</strong>
                            </div>
                          )}
                          {"currentCents" in activeDecision.placements.primary.card && (
                            <div>
                              <span>Current</span>
                              <strong>{formatCents(Number(activeDecision.placements.primary.card.currentCents))}</strong>
                            </div>
                          )}
                          {"portfolioCashCents" in activeDecision.placements.primary.card && (
                            <div>
                              <span>Portfolio Cash</span>
                              <strong>{formatCents(Number(activeDecision.placements.primary.card.portfolioCashCents))}</strong>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="pzn-empty-note">No primary task placement for this context (Pending Actions rail only).</p>
                  )}
                </article>

                {/* Next Action Placement */}
                <article className={"pzn-placement-card is-next-action" + (!activeDecision?.placements.nextAction ? " is-cleared" : "")}>
                  <div className="pzn-placement-kicker">OPTIONAL NEXT ACTION · PZN SHARED POLICY</div>
                  {activeDecision?.placements.nextAction && activeDecision.placements.nextAction.kind === "workflow" ? (
                    <>
                      <h3>{activeDecision.placements.nextAction.title}</h3>
                      <p>{activeDecision.placements.nextAction.summary}</p>
                      <div className="pzn-placement-meta">
                        <span>Rule: <code>{activeDecision.placements.nextAction.recommendationId}</code></span>
                        <span>Workflow: <code>{activeDecision.placements.nextAction.id}@{activeDecision.placements.nextAction.version}</code></span>
                      </div>
                      <div className="pzn-action-bar">
                        <button type="button" className="pzn-arch-btn-primary" disabled={busy} onClick={() => void executeWorkflow(false)}>
                          <Play size={13} aria-hidden="true" />
                          {activeDecision.placements.nextAction.ctaLabel} (sfield)
                        </button>
                        <button type="button" className="pzn-arch-btn-outline" disabled={busy} onClick={() => void executeWorkflow(true)}>
                          <ShieldAlert size={13} aria-hidden="true" />
                          Test Forged Token
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="pzn-cleared-state">
                      <CheckCircle2 size={20} aria-hidden="true" />
                      <div>
                        <strong>nextAction: null</strong>
                        <p>
                          {activeDecision?.refreshEvents.length
                            ? "Cleared live via funding.confirmed -> TS revision " + activeDecision.revision + "."
                            : "No eligible recommendation for this member/policy."}
                        </p>
                      </div>
                    </div>
                  )}
                </article>
              </div>

              {/* sfield 3-Step Workflow Preview + Live Refresh Controls */}
              {latestWorkflow && (
                <div className="pzn-workflow-box">
                  <div className="pzn-workflow-head">
                    <div>
                      <span className="pzn-mini-badge is-green">sfield Signed Execution · {latestWorkflow.turnRef}</span>
                      <h3>
                        {latestWorkflow.workflowId}@{latestWorkflow.workflowVersion} — Preview Ready ({formatCents(latestWorkflow.preview.amountCents)}{" "}
                        {latestWorkflow.preview.methodLabel})
                      </h3>
                    </div>
                    {activeDecision?.placements.nextAction && (
                      <div className="pzn-action-bar">
                        <button type="button" className="pzn-arch-btn-outline" disabled={busy} onClick={() => void confirmFunding(true)}>
                          <RefreshCw size={13} aria-hidden="true" />
                          Simulate Stale v{activeMember?.accountVersion}
                        </button>
                        <button type="button" className="pzn-arch-btn-primary" disabled={busy} onClick={() => void confirmFunding(false)}>
                          <CheckCircle2 size={13} aria-hidden="true" />
                          Emit funding.confirmed (v{(activeMember?.accountVersion ?? 41) + 1})
                        </button>
                      </div>
                    )}
                  </div>
                  <ol className="pzn-workflow-steps">
                    {latestWorkflow.steps.map((step) => (
                      <li key={step.step}>
                        <span className="pzn-step-num">{step.step}</span>
                        <div>
                          <strong>{step.label}</strong> <code>{step.toolRef}</code>
                          <pre>{JSON.stringify(step.response)}</pre>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>

            {/* Deep Architecture Inspector Tabs */}
            <div className="pzn-panel">
              <div className="pzn-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={activeTab === "trace"} className={activeTab === "trace" ? "is-active" : ""} onClick={() => setActiveTab("trace")}>
                  <Activity size={14} /> Exchange Trace ({activeDecision?.exchanges.length ?? 0})
                </button>
                <button type="button" role="tab" aria-selected={activeTab === "smass"} className={activeTab === "smass" ? "is-active" : ""} onClick={() => setActiveTab("smass")}>
                  <GitBranch size={14} /> smass Customer 360 Schema
                </button>
                <button type="button" role="tab" aria-selected={activeTab === "ranking"} className={activeTab === "ranking" ? "is-active" : ""} onClick={() => setActiveTab("ranking")}>
                  <TrendingUp size={14} /> Ranking Model Outcomes
                </button>
                <button type="button" role="tab" aria-selected={activeTab === "payload"} className={activeTab === "payload" ? "is-active" : ""} onClick={() => setActiveTab("payload")}>
                  <Layers size={14} /> Decision JSON
                </button>
              </div>

              {activeTab === "trace" && (
                <ol className="pzn-trace-list">
                  {activeDecision?.exchanges.map((ex) => (
                    <li key={`${ex.step}-${ex.stage}`} className={`pzn-trace-item stage-${ex.stage}`}>
                      <div className="pzn-trace-head">
                        <span className="pzn-step-num">{ex.step}</span>
                        <strong>{ex.from}</strong>
                        <ArrowRight size={13} aria-hidden="true" />
                        <strong>{ex.to}</strong>
                      </div>
                      <p className="pzn-trace-summary">{ex.summary}</p>
                      <details className="pzn-trace-details">
                        <summary>Inspect request &amp; response payload</summary>
                        <div className="pzn-trace-json-grid">
                          <div>
                            <span>Request</span>
                            <pre>{JSON.stringify(ex.request, null, 2)}</pre>
                          </div>
                          <div>
                            <span>Response</span>
                            <pre>{JSON.stringify(ex.response, null, 2)}</pre>
                          </div>
                        </div>
                      </details>
                    </li>
                  ))}
                </ol>
              )}

              {activeTab === "smass" && state?.smassGraph && (
                <div className="pzn-smass-view">
                  <p className="pzn-panel-sub">
                    Canonical <code>customer_360@1.0.0</code> compiled via <code>packages/smass</code> — shared by CCRE rules, Data Agg snapshots, and Treatment Resolver bindings.
                  </p>
                  <table className="pzn-table">
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Type</th>
                        <th>Constraints / Principal</th>
                        <th>Classification</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.smassGraph.entities[0]?.fields.map((field) => (
                        <tr key={field.key}>
                          <td><code>{field.key}</code></td>
                          <td>{field.type}{field.format ? ` (${field.format})` : ""}</td>
                          <td>
                            {field.primaryKey && <span className="pzn-mini-badge">PK</span>}{" "}
                            {field.principalKey && <span className="pzn-mini-badge is-green">principal.{field.principalKey}</span>}{" "}
                            {field.enumValues && <code>{field.enumValues.join(" | ")}</code>}
                          </td>
                          <td>{field.classification}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === "ranking" && (
                <div className="pzn-smass-view">
                  <p className="pzn-panel-sub">
                    Ranking Model score combines base relevance + verified <code>sfield</code> workflow completion lift (emit <code>funding.confirmed</code> to watch Marcus&rsquo;s completion update live).
                  </p>
                  <table className="pzn-table">
                    <thead>
                      <tr>
                        <th>Content ID</th>
                        <th>Base</th>
                        <th>Impressions</th>
                        <th>Clicks</th>
                        <th>Verified Outcomes</th>
                        <th>Effective Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state?.rankingMetrics.map((row) => (
                        <tr key={row.contentId}>
                          <td><strong>{row.label}</strong> <code>{row.contentId}</code></td>
                          <td>{row.baseScore.toFixed(2)}</td>
                          <td>{row.impressions}</td>
                          <td>{row.clicks}</td>
                          <td><strong>{row.verifiedOutcomes}</strong></td>
                          <td><span className="pzn-mini-badge is-green">{row.effectiveScore.toFixed(3)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === "payload" && (
                <pre className="pzn-json-block">{JSON.stringify(activeDecision, null, 2)}</pre>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
