import { useEffect, useId, useState } from "react";
import { FlaskConical } from "lucide-react";
import type { RuleCreationProps } from "../../packages/contracts/surface";
import { MAX_CCRE_RULES, treatmentOverride, type MockCcreRule, type ToolSetupView, type TreatmentPreview } from "../../packages/contracts/tool-setup";
import { api, toolSetupErrorMessage } from "./api";
import { CcreRuleForm } from "./ccre-rule-form";
import { TreatmentPreviewResult } from "./treatment-preview";

export function RuleCreationBlock({ scenarioId, personaId }: RuleCreationProps) {
  const id = useId();
  const [data, setData] = useState<ToolSetupView>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    void api.toolSetup().then(({ data }) => { if (mounted) setData(data); })
      .catch((error) => { if (mounted) setError(toolSetupErrorMessage(error)); });
    return () => { mounted = false; };
  }, [attempt]);

  return <section className="content-card rule-creation" aria-labelledby={id}>
    <h3 id={id}>Create a CCRE rule</h3>
    {data ? <RuleCreationEditor data={data} scenarioId={scenarioId} personaId={personaId} />
      : error ? <div className="rule-load-error">
        <p className="rule-error" role="alert">{error}</p>
        <button type="button" className="secondary-button" onClick={() => { setError(""); setAttempt(attempt + 1); }}>Retry loading setup</button>
      </div> : <p role="status">Loading rule setup…</p>}
  </section>;
}

function RuleCreationEditor({ data, scenarioId, personaId }: RuleCreationProps & { data: ToolSetupView }) {
  const id = useId();
  const [contextId, setContext] = useState(data.contexts[0]?.contextId ?? "");
  const [previewPersona, setPreviewPersona] = useState(personaId);
  const [turnNumber, setTurnNumber] = useState("1");
  const [pending, setPending] = useState<"preview" | "save">();
  const [saved, setSaved] = useState<MockCcreRule>();
  const [saveError, setSaveError] = useState("");
  const [preview, setPreview] = useState<{ key: string; result: TreatmentPreview } | { key: string; error: string }>();
  const scenario = data.scenarios.find((entry) => entry.scenarioId === scenarioId);
  const personas = data.personas.filter((entry) => entry.allowedScenarios.includes(scenarioId));
  const rules = data.setup.ccreRules ?? [];
  const existingTargets = new Set(rules.filter((rule) => rule.scenarioId === scenarioId && rule.contextId === contextId).map((rule) => rule.contentId));
  const targets = data.content.filter((entry) => !existingTargets.has(entry.contentId));
  const ordinal = Number(turnNumber);
  const canPreview = Number.isSafeInteger(ordinal) && ordinal > 0;
  const limitReached = rules.length >= MAX_CCRE_RULES;
  const keyFor = (rule: MockCcreRule | undefined) => JSON.stringify({ rule, previewPersona, ordinal });

  async function previewRule(rule: MockCcreRule) {
    const key = keyFor(rule);
    setPending("preview");
    setPreview(undefined);
    try {
      const { data: { setup } } = await api.toolSetup();
      const output = treatmentOverride(setup.treatmentOverrides, scenarioId, contextId)?.output ?? null;
      const ccreRules = (setup.ccreRules ?? []).filter((entry) => (
        entry.scenarioId === scenarioId && entry.contextId === contextId && entry.contentId !== rule.contentId
      ));
      const result = await api.previewTreatmentSelector({
        scenarioId, contextId, personaId: previewPersona, ordinal, enabled: setup.enabled.selection, output, ccreRules: [...ccreRules, rule],
      });
      setPreview({ key, result });
    } catch (error) {
      setPreview({ key, error: toolSetupErrorMessage(error) });
    } finally {
      setPending(undefined);
    }
  }

  async function saveRule(rule: MockCcreRule) {
    setPending("save");
    setSaveError("");
    try {
      setSaved(await api.createCcreRule(rule));
    } catch (error) {
      setSaveError(toolSetupErrorMessage(error));
    } finally {
      setPending(undefined);
    }
  }

  if (!scenario || !contextId || !personas.some((entry) => entry.personaId === personaId)) {
    return <p className="rule-error" role="alert">Rule setup is unavailable for this demo conversation.</p>;
  }
  return <div className="rule-creation-body">
    <p className="rule-scenario">Scenario <strong>{scenario.label}</strong></p>
    <div className="setup-field">
      <label htmlFor={id + "-context"}>Context</label>
      <select id={id + "-context"} disabled={Boolean(pending || saved)} value={contextId} onChange={(event) => {
        setContext(event.target.value);
        setSaveError("");
      }}>
        {data.contexts.map((entry) => <option key={entry.contextId} value={entry.contextId}>{entry.displayName}</option>)}
      </select>
    </div>
    {limitReached ? <p>The setup has reached its rule limit. <a href="/admin">Open Tool setup</a></p>
      : !targets.length ? <p>Every treatment has a rule in this context. <a href="/admin">Open Tool setup</a></p>
      : <CcreRuleForm scope={{ scenarioId, contextId }} personas={personas} targets={targets} defaultPersonaId={personaId} disabled={Boolean(pending || saved)}>
        {(rule) => {
          const result = preview?.key === keyFor(rule) ? preview : undefined;
          return <>
            <fieldset className="rule-creation-preview" disabled={Boolean(pending)}>
              <legend>Preview as</legend>
              <div className="rule-fields">
                <div className="setup-field">
                  <label htmlFor={id + "-preview-persona"}>Preview persona</label>
                  <select id={id + "-preview-persona"} value={previewPersona} onChange={(event) => setPreviewPersona(event.target.value)}>
                    {personas.map((entry) => <option key={entry.personaId} value={entry.personaId}>{entry.displayName}</option>)}
                  </select>
                </div>
                <label className="setup-field">Preview turn
                  <input type="number" min={1} step={1} value={turnNumber} onChange={(event) => setTurnNumber(event.target.value)} />
                </label>
              </div>
            </fieldset>
            <div className="rule-actions">
              <button className="secondary-button" type="button" disabled={!rule || !canPreview || Boolean(pending)}
                onClick={() => rule && void previewRule(rule)}><FlaskConical size={16} aria-hidden="true" />{pending === "preview" ? "Previewing…" : "Preview rule"}</button>
              <button className="send-button" type="button" disabled={!rule || Boolean(pending || saved)}
                onClick={() => rule && void saveRule(rule)}>{pending === "save" ? "Saving…" : saved ? "Saved" : "Save rule"}</button>
              {saved && <a href="/admin">Open Tool setup</a>}
            </div>
            {saved && <p className="rule-saved" role="status">Saved <strong>{saved.name}</strong>. The rule applies to subsequent chat turns in this scenario and context.</p>}
            {saveError && <p className="rule-error" role="alert">{saveError}</p>}
            {result && ("result" in result ? <TreatmentPreviewResult result={result.result} /> : <p className="rule-error" role="alert">{result.error}</p>)}
          </>;
        }}
      </CcreRuleForm>}
  </div>;
}
