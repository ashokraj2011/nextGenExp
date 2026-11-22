import { useId, useState, type ReactNode } from "react";
import {
  MAX_CCRE_RULE_NAME, MAX_CCRE_SOURCE_LENGTH, type MockCcreCondition, type MockCcreRule, type ToolSetupView,
} from "../../packages/contracts/tool-setup";
import "./ccre-rule.css";

export const conditionLabels = {
  persona_is: "Demo persona is",
  from_turn: "From turn number",
  always: "Always match",
  never: "Never match",
} satisfies Record<MockCcreCondition["kind"], string>;

type Props = {
  scope: Pick<MockCcreRule, "scenarioId" | "contextId">;
  targets: ToolSetupView["content"];
  personas: ToolSetupView["personas"];
  initialRule?: MockCcreRule;
  defaultPersonaId?: string;
  disabled?: boolean;
  children: (rule: MockCcreRule | undefined) => ReactNode;
};

export function CcreRuleForm({ scope, targets, personas, initialRule, defaultPersonaId, disabled, children }: Props) {
  const id = useId();
  const initialCondition = initialRule?.condition;
  const [draft, setDraft] = useState({
    name: initialRule?.name ?? "", contentId: initialRule?.contentId ?? targets[0]?.contentId ?? "",
    source: initialRule?.source ?? "", kind: initialCondition?.kind ?? "persona_is",
    personaId: initialCondition?.kind === "persona_is" ? initialCondition.personaId : defaultPersonaId ?? personas[0]?.personaId ?? "",
    ordinal: initialCondition?.kind === "from_turn" ? String(initialCondition.ordinal) : "2",
  });
  const contentId = targets.some((target) => target.contentId === draft.contentId) ? draft.contentId : "";
  const ordinal = Number(draft.ordinal);
  const canSave = draft.name.trim() && contentId
    && (draft.kind !== "persona_is" || personas.some(({ personaId }) => personaId === draft.personaId))
    && (draft.kind !== "from_turn" || (Number.isSafeInteger(ordinal) && ordinal > 0));
  const condition: MockCcreCondition = draft.kind === "persona_is" ? { kind: draft.kind, personaId: draft.personaId }
    : draft.kind === "from_turn" ? { kind: draft.kind, ordinal } : { kind: draft.kind };
  const rule = canSave ? { ...scope, name: draft.name.trim(), contentId, source: draft.source || undefined, condition } : undefined;

  return <>
    <fieldset className="rule-draft-fields" disabled={disabled}>
      <div className="rule-fields">
        <label className="setup-field">Rule name
          <input value={draft.name} maxLength={MAX_CCRE_RULE_NAME} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <div className="setup-field">
          <label htmlFor={id + "-treatment"}>Target treatment</label>
          <select id={id + "-treatment"} value={contentId} onChange={(event) => setDraft({ ...draft, contentId: event.target.value })}>
            {!contentId && <option value="" disabled>Choose a treatment</option>}
            {targets.map(({ contentId, title }) => <option key={contentId} value={contentId}>{title}</option>)}
          </select>
        </div>
        <div className="setup-field">
          <label htmlFor={id + "-condition"}>Mock condition</label>
          <select id={id + "-condition"} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as MockCcreCondition["kind"] })}>
            {Object.entries(conditionLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
        </div>
        {draft.kind === "persona_is" && <div className="setup-field">
          <label htmlFor={id + "-persona"}>Matching persona</label>
          <select id={id + "-persona"} value={draft.personaId} onChange={(event) => setDraft({ ...draft, personaId: event.target.value })}>
            {personas.map(({ personaId, displayName }) => <option key={personaId} value={personaId}>{displayName}</option>)}
          </select>
        </div>}
        {draft.kind === "from_turn" && <label className="setup-field">First matching turn
          <input type="number" min={1} step={1} value={draft.ordinal} onChange={(event) => setDraft({ ...draft, ordinal: event.target.value })} />
        </label>}
      </div>
      <div className="setup-field">
        <label htmlFor={id + "-source"}>CCRE source (optional)</label>
        <textarea id={id + "-source"} value={draft.source} rows={3} spellCheck={false} maxLength={MAX_CCRE_SOURCE_LENGTH}
          aria-describedby={id + "-source-note"} onChange={(event) => setDraft({ ...draft, source: event.target.value })} />
        <p id={id + "-source-note"} className="rule-field-note">Preview evaluates the mock condition. CCRE source is saved as text.</p>
      </div>
    </fieldset>
    {children(rule)}
  </>;
}
