import { useId } from "react";
import { customerWorkflows } from "../../packages/contracts/customer-workflows";
import type { WorkflowRecommendation } from "../../packages/contracts/funding-workflow";

export function RuleWorkflowPicker({ value, change, disabled = false }: {
  value?: WorkflowRecommendation | null; change: (ref: WorkflowRecommendation | null) => void; disabled?: boolean;
}) {
  const id = useId();
  const key = (ref: WorkflowRecommendation) => ref.id + "@" + ref.version;
  return <div className="setup-field">
    <label htmlFor={id}>Workflow on click</label>
    <select id={id} aria-describedby={id + "-hint"} value={value ? key(value) : ""} disabled={disabled}
      onChange={(event) => change(customerWorkflows.find((entry) => key(entry.recommendation) === event.target.value)?.recommendation ?? null)}>
      <option value="">No workflow</option>
      {customerWorkflows.map(({ label, recommendation }) =>
        <option key={key(recommendation)} value={key(recommendation)}>{label} · {key(recommendation)}</option>)}
    </select>
    <small id={id + "-hint"} className="rule-field-note">A matching rule recommends this workflow when its content appears in chat.</small>
  </div>;
}
