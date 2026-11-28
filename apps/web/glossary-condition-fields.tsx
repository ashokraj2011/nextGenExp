import { useId, useState, type ReactNode } from "react";
import {
  formatGlossaryCondition, glossaryAllowsCondition, glossaryOperatorLabels, type GlossaryAttribute,
  type GlossaryCondition, type GlossaryOperator, type RuleGlossary,
} from "../../packages/contracts/rule-glossary";

type Draft = { namespaceId: string; attributeId: string; operator: GlossaryOperator; value: string };
type Props = {
  glossary: RuleGlossary;
  initial?: GlossaryCondition;
  defaultValue?: string;
  children: (condition: GlossaryCondition | undefined, fields: ReactNode) => ReactNode;
};

function startingValue(attribute: GlossaryAttribute, defaultValue?: string) {
  if (attribute.valueType === "integer") return String(attribute.minimum ?? 0);
  if (attribute.valueType === "boolean") return "true";
  if (attribute.valueType === "string") return defaultValue ?? "";
  const option = attribute.options.find(({ value }) => value === defaultValue) ?? attribute.options[0];
  return option?.value ?? "";
}

function valueFrom(attribute: GlossaryAttribute, value: string): GlossaryCondition["value"] | undefined {
  if (!value.trim()) return undefined;
  if (attribute.valueType === "integer") return Number(value);
  if (attribute.valueType === "boolean") return value === "true";
  return value;
}

export function GlossaryConditionFields({ glossary, initial, defaultValue, children }: Props) {
  const id = useId();
  function selectAttribute(namespaceId: string, attribute: GlossaryAttribute) {
    return { namespaceId, attributeId: attribute.id, operator: attribute.operators[0], value: startingValue(attribute, defaultValue) };
  }
  const [draft, setDraft] = useState<Draft>(() => {
    const [namespace] = glossary.namespaces;
    if (!initial) return selectAttribute(namespace.id, namespace.attributes[0]);
    if (!glossaryAllowsCondition(glossary, initial)) return { namespaceId: "", attributeId: "", operator: "eq", value: "" };
    return { namespaceId: initial.namespaceId, attributeId: initial.attributeId, operator: initial.operator, value: String(initial.value) };
  });
  const namespace = glossary.namespaces.find(({ id }) => id === draft.namespaceId);
  const attribute = namespace?.attributes.find(({ id }) => id === draft.attributeId);
  const value = attribute && valueFrom(attribute, draft.value);
  const predicate = value === undefined ? undefined : {
    kind: "attribute" as const, glossaryVersion: glossary.version, namespaceId: draft.namespaceId,
    attributeId: draft.attributeId, operator: draft.operator, value,
  };
  const condition = predicate && glossaryAllowsCondition(glossary, predicate) ? predicate : undefined;

  return children(condition, <fieldset className="rule-glossary-condition">
    <legend>When this rule matches</legend>
    <div className="rule-fields">
      <div className="setup-field">
        <label htmlFor={id + "-namespace"}>Field group</label>
        <select id={id + "-namespace"} value={draft.namespaceId} onChange={(event) => {
          const next = glossary.namespaces.find(({ id }) => id === event.target.value);
          if (next) setDraft(selectAttribute(next.id, next.attributes[0]));
        }}>
          {!namespace && <option value="" disabled>Choose a group</option>}
          {glossary.namespaces.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <div className="setup-field">
        <label htmlFor={id + "-attribute"}>Field</label>
        <select id={id + "-attribute"} value={draft.attributeId} disabled={!namespace} onChange={(event) => {
          const next = namespace?.attributes.find(({ id }) => id === event.target.value);
          if (namespace && next) setDraft(selectAttribute(namespace.id, next));
        }} aria-describedby={attribute ? id + "-description" : undefined}>
          {namespace?.attributes.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      {attribute && <>
        <div className="setup-field">
          <label htmlFor={id + "-operator"}>Comparison</label>
          <select id={id + "-operator"} value={draft.operator} onChange={(event) => {
            const operator = attribute.operators.find((operator) => operator === event.target.value);
            if (operator) setDraft({ ...draft, operator });
          }}>
            {attribute.operators.map((operator) => <option key={operator} value={operator}>{glossaryOperatorLabels[operator]}</option>)}
          </select>
        </div>
        <div className="setup-field">
          <label htmlFor={id + "-value"}>Value</label>
          {attribute.valueType === "integer"
            ? <input id={id + "-value"} type="number" min={attribute.minimum ?? undefined} step={1}
                value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
            : attribute.valueType === "string"
              ? <input id={id + "-value"} type="text" placeholder="Enter value…"
                  value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
              : <select id={id + "-value"} value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })}>
                  {attribute.valueType === "boolean" ? <><option value="true">True</option><option value="false">False</option></>
                    : attribute.options.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                </select>}
        </div>
      </>}
    </div>
    {attribute && <p id={id + "-description"} className="rule-field-note">{attribute.description}</p>}
    {condition && <output className="rule-expression" aria-label="Rule expression"><code>{formatGlossaryCondition(condition)}</code></output>}
  </fieldset>);
}
