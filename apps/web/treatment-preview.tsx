import type { TreatmentPreview } from "../../packages/contracts/tool-setup";
import "./ccre-rule.css";

export function TreatmentPreviewResult({ result }: { result: TreatmentPreview }) {
  if (result.status === "disabled") return <div className="treatment-preview-result" role="status">Treatment Selector is disabled in this setup.</div>;
  const source = result.source === "override" ? "Configured response" : "Built-in fixture";
  return <div className="treatment-preview-result" role="status">
    <strong>{result.status === "timeout" ? "Simulated timeout" : result.status === "empty" ? "No eligible content" : "Ranked eligible content"}</strong>
    <p>{source}</p>
    {result.status === "ranked" && <ol aria-label="Eligible content in rank order">{result.contentIds.map((id) => <li key={id}><code>{id}</code></li>)}</ol>}
    {result.status !== "timeout" && result.ccre && <div className="ccre-evaluation">
      <h4>Mock CCRE evaluation</h4>
      <ul>
        {result.ccre.results.map(({ name, contentId, outcome }) => <li key={contentId}>
          <strong>{name}</strong>
          <code>{contentId}</code>
          <span>{outcome === "matched" ? "Matched" : outcome === "excluded" ? "Excluded" : "Outside the ranked list"}</span>
        </li>)}
      </ul>
      <details>
        <summary>Ranked content before rules</summary>
        {result.ccre.beforeRules.length ? <ol>{result.ccre.beforeRules.map((id) => <li key={id}><code>{id}</code></li>)}</ol> : <p>Empty list</p>}
      </details>
    </div>}
  </div>;
}
