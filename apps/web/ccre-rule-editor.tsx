import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  MAX_CCRE_RULE_NAME, MAX_CCRE_SOURCE_LENGTH, type MockCcreCondition, type MockCcreRule, type ToolSetupView,
} from "../../packages/contracts/tool-setup";

const conditionLabels = {
  persona_is: "Demo persona is",
  from_turn: "From turn number",
  always: "Always match",
  never: "Never match",
} satisfies Record<MockCcreCondition["kind"], string>;
type Draft = {
  name: string;
  contentId: string;
  source: string;
  kind: MockCcreCondition["kind"];
  personaId: string;
  ordinal: string;
  replacing?: string;
};
type Props = {
  scope: Pick<MockCcreRule, "scenarioId" | "contextId">;
  rules: MockCcreRule[];
  personas: ToolSetupView["personas"];
  content: ToolSetupView["content"];
  limitReached: boolean;
  change: (rules: MockCcreRule[]) => void;
};

export function CcreRuleEditor({ scope, rules, personas, content, limitReached, change }: Props) {
  const [draft, setDraft] = useState<Draft>();
  const targets = content.filter(({ contentId }) => contentId === draft?.replacing || !rules.some((rule) => rule.contentId === contentId));
  function start(rule?: MockCcreRule) {
    const condition = rule?.condition;
    setDraft({
      name: rule?.name ?? "", source: rule?.source ?? "", replacing: rule?.contentId,
      contentId: rule?.contentId ?? targets[0]?.contentId ?? "",
      kind: condition?.kind ?? "persona_is",
      personaId: condition?.kind === "persona_is" ? condition.personaId : personas[0]?.personaId ?? "",
      ordinal: condition?.kind === "from_turn" ? String(condition.ordinal) : "2",
    });
  }
  function describe(condition: MockCcreCondition) {
    const label = conditionLabels[condition.kind];
    if (condition.kind === "persona_is") return label + " " + (personas.find((entry) => entry.personaId === condition.personaId)?.displayName ?? condition.personaId);
    if (condition.kind === "from_turn") return label + " " + condition.ordinal;
    return label;
  }
  function saveRule() {
    if (!draft || !canSave) return;
    let condition: MockCcreCondition;
    switch (draft.kind) {
      case "persona_is": condition = { kind: "persona_is", personaId: draft.personaId }; break;
      case "from_turn": condition = { kind: "from_turn", ordinal: Number(draft.ordinal) }; break;
      default: condition = { kind: draft.kind };
    }
    const rule: MockCcreRule = {
      ...scope, name: draft.name.trim(), contentId: draft.contentId, source: draft.source || undefined, condition,
    };
    change(draft.replacing ? rules.map((entry) => entry.contentId === draft.replacing ? rule : entry) : [...rules, rule]);
    setDraft(undefined);
  }
  const canSave = draft && draft.name.trim() && targets.some(({ contentId }) => contentId === draft.contentId)
    && (draft.kind !== "persona_is" || personas.some(({ personaId }) => personaId === draft.personaId))
    && (draft.kind !== "from_turn" || (Number.isSafeInteger(Number(draft.ordinal)) && Number(draft.ordinal) > 0));

  return <div className="admin-rules">
    <div className="admin-rules-heading">
      <div>
        <h3>CCRE rules</h3>
        <p>The mock keeps a treatment when its condition matches. Rules apply to the selected scenario and context.</p>
      </div>
      {!draft && <button className="secondary-button" type="button" disabled={limitReached || !targets.length} onClick={() => start()}>
        <Plus size={16} aria-hidden="true" />Create rule
      </button>}
    </div>
    {limitReached && <p className="admin-muted">The setup has reached its rule limit.</p>}
    {!!rules.length && <ul className="rank-list admin-rule-list" aria-label="CCRE rules for this context">
      {rules.map((rule) => <li key={rule.contentId}>
        <span className="rank-item"><strong>{rule.name}</strong><code>{rule.contentId}</code><small>{describe(rule.condition)}</small></span>
        <span className="rank-actions">
          <button type="button" className="icon-button" aria-label={`Edit rule ${rule.name}`} disabled={Boolean(draft)} onClick={() => start(rule)}>
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label={`Remove rule ${rule.name}`} disabled={Boolean(draft)}
            onClick={() => change(rules.filter((entry) => entry !== rule))}><Trash2 size={16} aria-hidden="true" /></button>
        </span>
      </li>)}
    </ul>}
    {draft && <div className="admin-rule-draft">
      <div className="admin-rule-fields">
        <label className="admin-field">Rule name
          <input value={draft.name} maxLength={MAX_CCRE_RULE_NAME} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <div className="admin-field">
          <label htmlFor="ccre-treatment">Target treatment</label>
          <select id="ccre-treatment" value={draft.contentId} onChange={(event) => setDraft({ ...draft, contentId: event.target.value })}>
            {targets.map(({ contentId, title }) => <option key={contentId} value={contentId}>{title}</option>)}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="ccre-condition">Mock condition</label>
          <select id="ccre-condition" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Draft["kind"] })}>
            {Object.entries(conditionLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
        </div>
        {draft.kind === "persona_is" && <div className="admin-field">
          <label htmlFor="ccre-persona">Matching persona</label>
          <select id="ccre-persona" value={draft.personaId} onChange={(event) => setDraft({ ...draft, personaId: event.target.value })}>
            {personas.map(({ personaId, displayName }) => <option key={personaId} value={personaId}>{displayName}</option>)}
          </select>
        </div>}
        {draft.kind === "from_turn" && <label className="admin-field">First matching turn
          <input type="number" min={1} step={1} value={draft.ordinal} onChange={(event) => setDraft({ ...draft, ordinal: event.target.value })} />
        </label>}
      </div>
      <div className="admin-field">
        <label htmlFor="ccre-source">CCRE source (optional)</label>
        <textarea id="ccre-source" value={draft.source} rows={3} spellCheck={false} maxLength={MAX_CCRE_SOURCE_LENGTH}
          aria-describedby="ccre-source-note" onChange={(event) => setDraft({ ...draft, source: event.target.value })} />
        <p id="ccre-source-note">Paste your CCRE rule for future integration. Preview evaluates the mock condition.</p>
      </div>
      <div className="admin-rule-actions">
        <button type="button" className="send-button" disabled={!canSave} onClick={saveRule}>{draft.replacing ? "Update rule" : "Add rule"}</button>
        <button type="button" className="icon-button" onClick={() => setDraft(undefined)}>Cancel</button>
      </div>
    </div>}
  </div>;
}
