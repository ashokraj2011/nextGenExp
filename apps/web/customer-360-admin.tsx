import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Plus, RotateCcw, Save, Sparkles, Trash2, UserCheck, UsersRound } from "lucide-react";
import type {
  CustomAttribute,
  CustomAttributeType,
  Customer360AdminRecord,
  Customer360ProfileInput,
} from "../../packages/contracts/customer-360";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import { api } from "./api";
import { rememberActiveConversation, saveProfileSession } from "./conversation-storage";
import { ProfileAvatar } from "./demo-profiles";
import "./customer-360-admin.css";

type FormState = {
  personaId?: string;
  displayName: string;
  segment: string;
  notes: string;
  accountFundingStatus: "funded" | "unfunded";
  beneficiaryStatus: "on_file" | "missing";
  availableBalanceDollars: string;
  currentBalanceDollars: string;
  cashDollars: string;
  equityDollars: string;
  fixedIncomeDollars: string;
  homeGoalTargetDollars: string;
  homeGoalSavedDollars: string;
  customAttributes: CustomAttribute[];
};

function slugKey(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]+/, "");
  return cleaned.slice(0, 48);
}

function centsToDollarsInput(cents: number): string {
  const val = cents / 100;
  return Number.isInteger(val) ? String(val) : val.toFixed(2);
}

function dollarsInputToCents(raw: string): number {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100);
}

function recordToForm(record: Customer360AdminRecord): FormState {
  return {
    personaId: record.personaId,
    displayName: record.displayName,
    segment: record.segment,
    notes: record.notes,
    accountFundingStatus: record.accountFundingStatus,
    beneficiaryStatus: record.beneficiaryStatus,
    availableBalanceDollars: centsToDollarsInput(record.availableBalanceCents),
    currentBalanceDollars: centsToDollarsInput(record.currentBalanceCents),
    cashDollars: centsToDollarsInput(record.cashCents),
    equityDollars: centsToDollarsInput(record.equityCents),
    fixedIncomeDollars: centsToDollarsInput(record.fixedIncomeCents),
    homeGoalTargetDollars: centsToDollarsInput(record.homeGoalTargetCents),
    homeGoalSavedDollars: centsToDollarsInput(record.homeGoalSavedCents),
    customAttributes: (record.customAttributes ?? []).map((a) => ({ ...a })),
  };
}

function emptyNewForm(): FormState {
  return {
    personaId: undefined,
    displayName: "",
    segment: "Mass Affluent · Growth",
    notes: "",
    accountFundingStatus: "funded",
    beneficiaryStatus: "missing",
    availableBalanceDollars: "3200",
    currentBalanceDollars: "3500",
    cashDollars: "18000",
    equityDollars: "42000",
    fixedIncomeDollars: "15000",
    homeGoalTargetDollars: "80000",
    homeGoalSavedDollars: "32000",
    customAttributes: [
      { key: "risk_tolerance", label: "Risk tolerance", type: "text", value: "Moderate Growth" },
      { key: "advisor_name", label: "Dedicated advisor", type: "text", value: "Priya Sharma" },
    ],
  };
}

export function Customer360Admin() {
  const [customers, setCustomers] = useState<Customer360AdminRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | "new">("");
  const [form, setForm] = useState<FormState>(emptyNewForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    void api.customers().then(({ customers: list }) => {
      if (!active) return;
      setCustomers(list);
      if (list[0]) {
        setSelectedId(list[0].personaId);
        setForm(recordToForm(list[0]));
      }
      setLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load customer profiles." });
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const selectedRecord = useMemo(
    () => (selectedId && selectedId !== "new" ? customers.find((c) => c.personaId === selectedId) : undefined),
    [customers, selectedId],
  );

  function selectProfile(record: Customer360AdminRecord) {
    setSelectedId(record.personaId);
    setForm(recordToForm(record));
    setNotice(null);
  }

  function startNewProfile() {
    setSelectedId("new");
    setForm(emptyNewForm());
    setNotice(null);
  }

  const cashCents = dollarsInputToCents(form.cashDollars);
  const equityCents = dollarsInputToCents(form.equityDollars);
  const fixedIncomeCents = dollarsInputToCents(form.fixedIncomeDollars);
  const totalPortfolioCents = cashCents + equityCents + fixedIncomeCents;
  const targetCents = dollarsInputToCents(form.homeGoalTargetDollars);
  const savedCents = dollarsInputToCents(form.homeGoalSavedDollars);
  const goalPct = targetCents > 0 ? Math.min(100, Math.round((savedCents / targetCents) * 100)) : 0;

  const cashShare = totalPortfolioCents > 0 ? Math.round((cashCents / totalPortfolioCents) * 100) : 0;
  const equityShare = totalPortfolioCents > 0 ? Math.round((equityCents / totalPortfolioCents) * 100) : 0;
  const fixedShare = totalPortfolioCents > 0 ? Math.max(0, 100 - cashShare - equityShare) : 0;

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    if (!form.displayName.trim()) {
      setNotice({ tone: "error", text: "Enter a customer display name before saving." });
      return;
    }
    setSaving(true);
    setNotice(null);
    const payload: Customer360ProfileInput = {
      ...(form.personaId ? { personaId: form.personaId } : {}),
      displayName: form.displayName.trim(),
      segment: form.segment.trim(),
      notes: form.notes.trim(),
      accountFundingStatus: form.accountFundingStatus,
      beneficiaryStatus: form.beneficiaryStatus,
      availableBalanceCents: dollarsInputToCents(form.availableBalanceDollars),
      currentBalanceCents: dollarsInputToCents(form.currentBalanceDollars),
      cashCents,
      equityCents,
      fixedIncomeCents,
      homeGoalTargetCents: targetCents,
      homeGoalSavedCents: savedCents,
      customAttributes: form.customAttributes
        .map((attr) => ({
          key: slugKey(attr.key || attr.label),
          label: attr.label.trim() || attr.key.trim(),
          type: attr.type,
          value: attr.value.trim(),
        }))
        .filter((attr) => /^[a-z][a-z0-9_]{0,47}$/.test(attr.key) && attr.label.length > 0),
    };
    try {
      const response = await api.saveCustomer(payload);
      setCustomers(response.customers);
      const saved = response.customer ?? response.customers[response.customers.length - 1];
      if (saved) {
        setSelectedId(saved.personaId);
        setForm(recordToForm(saved));
      }
      setNotice({
        tone: "ok",
        text: form.personaId
          ? `Saved Customer 360 profile for ${payload.displayName}.`
          : `Created new customer profile ${payload.displayName} — ready in Login & Switch Profile.`,
      });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save profile." });
    } finally {
      setSaving(false);
    }
  }

  async function deleteOrReset() {
    if (!selectedRecord) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await api.deleteOrResetCustomer(selectedRecord.personaId);
      setCustomers(response.customers);
      if (response.deleted) {
        const fallback = response.customers[0];
        if (fallback) {
          setSelectedId(fallback.personaId);
          setForm(recordToForm(fallback));
        } else {
          startNewProfile();
        }
        setNotice({ tone: "ok", text: `Deleted custom profile ${selectedRecord.displayName}.` });
      } else {
        const refreshed = response.customers.find((c) => c.personaId === selectedRecord.personaId);
        if (refreshed) setForm(recordToForm(refreshed));
        setNotice({ tone: "ok", text: `Reset ${selectedRecord.displayName} back to default values.` });
      }
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Action failed." });
    } finally {
      setSaving(false);
    }
  }

  async function resetDismissedNbas() {
    if (!selectedRecord) return;
    setSaving(true);
    try {
      const response = await api.resetCustomerNba(selectedRecord.personaId);
      setCustomers(response.customers);
      setNotice({ tone: "ok", text: `Reset dismissed Next Best Actions for ${selectedRecord.displayName}.` });
    } catch (error: unknown) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not reset dismissals." });
    } finally {
      setSaving(false);
    }
  }

  function launchChatAs(personaId: string) {
    rememberActiveConversation(null);
    saveProfileSession(personaId);
    location.href = "/chat";
  }

  return (
    <main className="admin-page c360-page">
      <header className="c360-header">
        <div>
          <p className="c360-eyebrow"><UsersRound size={15} aria-hidden="true" />Customer 360 Data Store</p>
          <h1>Customer 360 Profiles</h1>
          <p className="c360-subtitle">
            Create new customer profiles or edit balances, portfolio allocations, funding, beneficiaries, and savings goals.
            Changes flow immediately into Login, Switch Profile, Balance/Portfolio tools, Treatment Selector, and Next Best Action arbitration.
          </p>
        </div>
        <button type="button" className="c360-primary-btn" onClick={startNewProfile}>
          <Plus size={16} aria-hidden="true" />New profile
        </button>
      </header>

      {notice && (
        <p className={"c360-notice " + (notice.tone === "error" ? "is-error" : "is-ok")} role="status">
          {notice.text}
        </p>
      )}

      {loading ? (
        <p className="workspace-loading" role="status">Loading Customer 360 profiles…</p>
      ) : (
        <div className="c360-grid">
          <section className="c360-directory" aria-label="Customer profiles">
            <div className="c360-directory-head">
              <h2>Profiles ({customers.length})</h2>
            </div>
            <div className="c360-list">
              {customers.map((customer) => {
                const total = customer.cashCents + customer.equityCents + customer.fixedIncomeCents;
                const active = selectedId === customer.personaId;
                return (
                  <button
                    key={customer.personaId}
                    type="button"
                    className={"c360-list-item" + (active ? " is-active" : "")}
                    onClick={() => selectProfile(customer)}
                  >
                    <ProfileAvatar name={customer.displayName} />
                    <div className="c360-list-meta">
                      <div className="c360-list-title-row">
                        <strong>{customer.displayName}</strong>
                        {!customer.isBuiltIn && <span className="c360-tag tag-custom">Custom</span>}
                        {customer.isBuiltIn && customer.isCustomized && <span className="c360-tag tag-edited">Edited</span>}
                      </div>
                      <span className="c360-list-sub">{customer.segment || customer.syntheticMid}</span>
                      <div className="c360-list-stats">
                        <span>{formatPortfolioAmount(total)} total</span>
                        <span>·</span>
                        <span>{formatPortfolioAmount(customer.cashCents)} cash</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="c360-editor-column" aria-label="Profile editor">
            <form className="c360-card c360-form" onSubmit={(e) => void saveProfile(e)}>
              <div className="c360-form-header">
                <div>
                  <h2>{selectedId === "new" ? "Create new customer profile" : `Edit ${form.displayName || "profile"}`}</h2>
                  {selectedRecord && (
                    <p className="c360-id-line">
                      ID: <code>{selectedRecord.personaId}</code> · Member Ref: <code>{selectedRecord.syntheticMid}</code>
                    </p>
                  )}
                </div>
                {selectedRecord && (
                  <button
                    type="button"
                    className="secondary-button c360-launch-btn"
                    onClick={() => launchChatAs(selectedRecord.personaId)}
                  >
                    Open chat as {selectedRecord.displayName.split(" ")[0]} <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                )}
              </div>

              <div className="c360-section">
                <h3>Identity &amp; Account Readiness</h3>
                <div className="c360-fields c360-fields-2">
                  <label className="c360-field">
                    <span>Display name</span>
                    <input
                      type="text"
                      value={form.displayName}
                      placeholder="e.g. Priya Nair"
                      required
                      onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
                    />
                  </label>
                  <label className="c360-field">
                    <span>Customer segment</span>
                    <input
                      type="text"
                      value={form.segment}
                      placeholder="e.g. Mass Affluent · Growth"
                      onChange={(e) => setForm((prev) => ({ ...prev, segment: e.target.value }))}
                    />
                  </label>
                  <label className="c360-field">
                    <span>Account funding status</span>
                    <select
                      value={form.accountFundingStatus}
                      onChange={(e) => setForm((prev) => ({ ...prev, accountFundingStatus: e.target.value as "funded" | "unfunded" }))}
                    >
                      <option value="funded">Funded</option>
                      <option value="unfunded">Unfunded (awaiting first deposit)</option>
                    </select>
                  </label>
                  <label className="c360-field">
                    <span>Beneficiary status</span>
                    <select
                      value={form.beneficiaryStatus}
                      onChange={(e) => setForm((prev) => ({ ...prev, beneficiaryStatus: e.target.value as "on_file" | "missing" }))}
                    >
                      <option value="on_file">On file</option>
                      <option value="missing">Missing</option>
                    </select>
                  </label>
                </div>
                <label className="c360-field">
                  <span>Advisor &amp; Customer 360 context notes</span>
                  <textarea
                    rows={2}
                    value={form.notes}
                    placeholder="Key life events, risk appetite, or notes used by Customer 360 lookup..."
                    onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                  />
                </label>
              </div>

              <div className="c360-section">
                <h3>Balances &amp; Portfolio Holdings (USD)</h3>
                <div className="c360-fields c360-fields-2">
                  <label className="c360-field">
                    <span>Available balance ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.availableBalanceDollars}
                      onChange={(e) => setForm((prev) => ({ ...prev, availableBalanceDollars: e.target.value }))}
                    />
                  </label>
                  <label className="c360-field">
                    <span>Current / ledger balance ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.currentBalanceDollars}
                      onChange={(e) => setForm((prev) => ({ ...prev, currentBalanceDollars: e.target.value }))}
                    />
                  </label>
                </div>
                <div className="c360-fields c360-fields-3">
                  <label className="c360-field">
                    <span>Cash reserve ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={form.cashDollars}
                      onChange={(e) => setForm((prev) => ({ ...prev, cashDollars: e.target.value }))}
                    />
                  </label>
                  <label className="c360-field">
                    <span>Equities ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={form.equityDollars}
                      onChange={(e) => setForm((prev) => ({ ...prev, equityDollars: e.target.value }))}
                    />
                  </label>
                  <label className="c360-field">
                    <span>Fixed income ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={form.fixedIncomeDollars}
                      onChange={(e) => setForm((prev) => ({ ...prev, fixedIncomeDollars: e.target.value }))}
                    />
                  </label>
                </div>
                <div className="c360-allocation-preview">
                  <div className="c360-allocation-summary">
                    <span>Total Portfolio: <strong>{formatPortfolioAmount(totalPortfolioCents)}</strong></span>
                    <span>Stocks {equityShare}% · Fixed Income {fixedShare}% · Cash {cashShare}%</span>
                  </div>
                  <div className="c360-bar" aria-hidden="true">
                    <span className="seg-equity" style={{ width: `${equityShare}%` }} />
                    <span className="seg-fixed" style={{ width: `${fixedShare}%` }} />
                    <span className="seg-cash" style={{ width: `${cashShare}%` }} />
                  </div>
                </div>
              </div>

              <div className="c360-section">
                <h3>Home Down-Payment Goal (USD)</h3>
                <div className="c360-fields c360-fields-2">
                  <label className="c360-field">
                    <span>Goal target ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="500"
                      value={form.homeGoalTargetDollars}
                      onChange={(e) => setForm((prev) => ({ ...prev, homeGoalTargetDollars: e.target.value }))}
                    />
                  </label>
                  <label className="c360-field">
                    <span>Saved so far ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="500"
                      value={form.homeGoalSavedDollars}
                      onChange={(e) => setForm((prev) => ({ ...prev, homeGoalSavedDollars: e.target.value }))}
                    />
                  </label>
                </div>
                {targetCents > 0 && (
                  <p className="c360-goal-hint">
                    Goal progress: <strong>{goalPct}% funded</strong> ({formatPortfolioAmount(savedCents)} of {formatPortfolioAmount(targetCents)})
                  </p>
                )}
              </div>

              <div className="c360-section">
                <div className="c360-section-head-row">
                  <h3>Custom Attributes (Dynamic Key / Value · {form.customAttributes.length}/20)</h3>
                  <button
                    type="button"
                    className="c360-mini-add"
                    disabled={form.customAttributes.length >= 20}
                    onClick={() => setForm((prev) => ({
                      ...prev,
                      customAttributes: [
                        ...prev.customAttributes,
                        { key: "", label: "", type: "text", value: "" },
                      ],
                    }))}
                  >
                    <Plus size={13} aria-hidden="true" />Add attribute
                  </button>
                </div>
                {form.customAttributes.length === 0 ? (
                  <p className="c360-goal-hint">
                    Add custom key/value pairs (e.g. <code>risk_tolerance</code>, <code>advisor_name</code>, <code>annual_bonus</code>) — they automatically become bindable in <a href={adminPaths.builder}>UI Builder</a>.
                  </p>
                ) : (
                  <div className="c360-kv-list">
                    {form.customAttributes.map((attr, idx) => {
                      const resolvedKey = slugKey(attr.key || attr.label);
                      return (
                        <div key={idx} className="c360-kv-row">
                          <input
                            aria-label={`Attribute ${idx + 1} label`}
                            placeholder="Label (e.g. Annual bonus)"
                            value={attr.label}
                            maxLength={60}
                            onChange={(e) => {
                              const nextLabel = e.target.value;
                              setForm((prev) => ({
                                ...prev,
                                customAttributes: prev.customAttributes.map((item, i) => (
                                  i === idx
                                    ? { ...item, label: nextLabel, key: item.key ? item.key : slugKey(nextLabel) }
                                    : item
                                )),
                              }));
                            }}
                          />
                          <input
                            aria-label={`Attribute ${idx + 1} key`}
                            placeholder="snake_case_key"
                            value={attr.key}
                            maxLength={48}
                            onChange={(e) => setForm((prev) => ({
                              ...prev,
                              customAttributes: prev.customAttributes.map((item, i) => (
                                i === idx ? { ...item, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") } : item
                              )),
                            }))}
                          />
                          <select
                            aria-label={`Attribute ${idx + 1} type`}
                            value={attr.type}
                            onChange={(e) => setForm((prev) => ({
                              ...prev,
                              customAttributes: prev.customAttributes.map((item, i) => (
                                i === idx ? { ...item, type: e.target.value as CustomAttributeType } : item
                              )),
                            }))}
                          >
                            <option value="text">Text</option>
                            <option value="currency">Currency ($)</option>
                            <option value="number">Number</option>
                            <option value="percent">Percent (%)</option>
                          </select>
                          <input
                            aria-label={`Attribute ${idx + 1} value`}
                            placeholder={attr.type === "currency" ? "15000" : attr.type === "percent" ? "75" : "Value..."}
                            value={attr.value}
                            maxLength={160}
                            onChange={(e) => setForm((prev) => ({
                              ...prev,
                              customAttributes: prev.customAttributes.map((item, i) => (
                                i === idx ? { ...item, value: e.target.value } : item
                              )),
                            }))}
                          />
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Remove attribute ${idx + 1}`}
                            onClick={() => setForm((prev) => ({
                              ...prev,
                              customAttributes: prev.customAttributes.filter((_, i) => i !== idx),
                            }))}
                          >
                            <Trash2 size={14} />
                          </button>
                          {resolvedKey && (
                            <span className="c360-kv-token">
                              Bind in UI Builder: <code>{"{{"}custom.{resolvedKey}{"}}"}</code>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="c360-goal-hint">
                  Custom attributes automatically appear under <strong>Custom Attributes</strong> in <a href={adminPaths.builder}>UI Builder</a>&rsquo;s <em>Bind data</em> and <em>Pre-fill</em> dropdowns.
                </p>
              </div>

              <div className="c360-form-actions">
                <button type="submit" className="c360-primary-btn" disabled={saving}>
                  <Save size={15} aria-hidden="true" />
                  {saving ? "Saving…" : selectedId === "new" ? "Create profile" : "Save changes"}
                </button>
                {selectedRecord && !selectedRecord.isBuiltIn && (
                  <button type="button" className="secondary-button c360-danger-btn" disabled={saving} onClick={() => void deleteOrReset()}>
                    <Trash2 size={15} aria-hidden="true" />Delete profile
                  </button>
                )}
                {selectedRecord && selectedRecord.isBuiltIn && selectedRecord.isCustomized && (
                  <button type="button" className="secondary-button" disabled={saving} onClick={() => void deleteOrReset()}>
                    <RotateCcw size={15} aria-hidden="true" />Reset to defaults
                  </button>
                )}
              </div>
            </form>

            {selectedRecord && (
              <div className="c360-card c360-preview-card">
                <div className="c360-preview-head">
                  <h3><UserCheck size={16} aria-hidden="true" />Live Customer 360 &amp; Next Best Action Preview</h3>
                  {selectedRecord.dismissedNbaIds.length > 0 && (
                    <button type="button" className="secondary-button" disabled={saving} onClick={() => void resetDismissedNbas()}>
                      <RotateCcw size={14} aria-hidden="true" />Reset {selectedRecord.dismissedNbaIds.length} dismissed NBA{selectedRecord.dismissedNbaIds.length === 1 ? "" : "s"}
                    </button>
                  )}
                </div>
                <div className="c360-highlight-chips">
                  {selectedRecord.lookup.highlights.map((chip) => (
                    <span key={chip} className="c360-chip">{chip}</span>
                  ))}
                </div>
                {selectedRecord.nba ? (
                  <div className="c360-nba-box">
                    <span className="c360-nba-kicker"><Sparkles size={13} aria-hidden="true" />{selectedRecord.nba.kicker}</span>
                    <strong>{selectedRecord.nba.title}</strong>
                    <p>{selectedRecord.nba.body}</p>
                    <small>Arbitration reason: {selectedRecord.nba.reason}</small>
                  </div>
                ) : (
                  <p className="c360-empty-nba">No active Next Best Action (all eligible recommendations are dismissed or complete).</p>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
