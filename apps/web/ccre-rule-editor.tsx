import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { formatGlossaryCondition, type RuleGlossary } from "../../packages/contracts/rule-glossary";
import { effectiveCcreRules, type MockCcreCondition, type MockCcreRule, type ToolSetupView } from "../../packages/contracts/tool-setup";
import { CcreRuleForm, conditionLabels } from "./ccre-rule-form";

type Props = {
  scope: Pick<MockCcreRule, "scenarioId" | "contextId">;
  rules: MockCcreRule[];
  defaults: Omit<MockCcreRule, "scenarioId">[];
  personas: ToolSetupView["personas"];
  content: ToolSetupView["content"];
  glossary: RuleGlossary;
  limitReached: boolean;
  change: (rules: MockCcreRule[]) => void;
};

export function CcreRuleEditor({ scope, rules, defaults, personas, content, glossary, limitReached, change }: Props) {
  const [editor, setEditor] = useState<{ rule?: MockCcreRule }>();
  const replacing = editor?.rule;
  const base = defaults.filter((rule) => rule.contextId === scope.contextId);
  const effective = effectiveCcreRules(scope.scenarioId, scope.contextId, base, rules);
  const editingDefault = base.some((rule) => rule.contentId === replacing?.contentId);
  const targets = content.filter(({ contentId }) => contentId === replacing?.contentId
    || (!editingDefault && !effective.some((rule) => rule.contentId === contentId)));
  function describe(condition: MockCcreCondition) {
    if (condition.kind === "attribute") return formatGlossaryCondition(condition);
    const label = conditionLabels[condition.kind];
    if (condition.kind === "persona_is") return label + " " + (personas.find((entry) => entry.personaId === condition.personaId)?.displayName ?? condition.personaId);
    if (condition.kind === "from_turn") return label + " " + condition.ordinal;
    return label;
  }
  function saveRule(rule: MockCcreRule) {
    const index = rules.findIndex((entry) => entry.contentId === replacing?.contentId);
    change(index < 0 ? [...rules, rule] : rules.map((entry, i) => i === index ? rule : entry));
    setEditor(undefined);
  }

  return <div className="admin-rules">
    <div className="admin-rules-heading">
      <div>
        <h3>CCRE rules</h3>
        <p>A rule controls when an item can appear. These rules apply to this test case and topic.</p>
      </div>
      {!editor && <button className="secondary-button" type="button" disabled={limitReached || !targets.length} onClick={() => setEditor({})}>
        <Plus size={16} aria-hidden="true" />Create rule
      </button>}
    </div>
    {limitReached && <p className="admin-muted">The setup has reached its rule limit.</p>}
    {!!effective.length && <ul className="rank-list admin-rule-list" aria-label="CCRE rules for this context">
      {effective.map((rule) => <li key={rule.contentId}>
        <span className="rank-item"><strong>{rule.name}</strong><code>{rule.contentId}</code><small>{describe(rule.condition)}</small>{rule.workflow && <small>On click · {rule.workflow.id}@{rule.workflow.version}</small>}</span>
        <span className="rank-actions">
          <button type="button" className="icon-button" aria-label={`Edit rule ${rule.name}`} disabled={Boolean(editor) || (limitReached && !rules.some((r) => r.contentId === rule.contentId))} onClick={() => setEditor({ rule })}>
            <Pencil size={16} aria-hidden="true" />
          </button>
          {rules.some((entry) => entry.contentId === rule.contentId) &&
            <button type="button" className="icon-button" aria-label={`${base.some((r) => r.contentId === rule.contentId) ? "Restore default for" : "Remove rule"} ${rule.name}`} disabled={Boolean(editor)}
              onClick={() => change(rules.filter((entry) => entry.contentId !== rule.contentId))}><Trash2 size={16} aria-hidden="true" /></button>}
        </span>
      </li>)}
    </ul>}
    {editor && <div className="admin-rule-draft">
      <CcreRuleForm scope={scope} personas={personas} targets={targets} initialRule={replacing}
        glossary={replacing?.condition.kind === "attribute" ? glossary : undefined}>
        {(rule) => <div className="rule-actions">
          <button type="button" className="send-button" disabled={!rule} onClick={() => rule && saveRule(rule)}>
            {replacing ? "Update rule" : "Add rule"}
          </button>
          <button type="button" className="icon-button" onClick={() => setEditor(undefined)}>Cancel</button>
        </div>}
      </CcreRuleForm>
    </div>}
  </div>;
}
