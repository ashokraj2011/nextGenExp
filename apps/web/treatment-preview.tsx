import type { TreatmentPreview } from "../../packages/contracts/tool-setup";
import "./ccre-rule.css";

export function TreatmentPreviewResult({ result }: { result: TreatmentPreview }) {
  if (result.status === "disabled") return <div className="treatment-preview-result" role="status">Treatment Selector is disabled in this setup.</div>;
  const source = result.source === "override" ? "Custom response" : "Default response";
  return <div className="treatment-preview-result" role="status">
    <strong>{result.status === "timeout" ? "Simulated timeout" : result.status === "empty" ? "No matching content" : "Matching content"}</strong>
    <p>{source}</p>
    {result.status === "ranked" && <ol aria-label="Matching content in order">{result.contentIds.map((id) => <li key={id}><code>{id}</code></li>)}</ol>}
    {result.status !== "timeout" && result.ccre && <div className="ccre-evaluation">
      <h4>Rule results</h4>
      <ul>
        {result.ccre.results.map(({ name, contentId, outcome }) => <li key={contentId}>
          <strong>{name}</strong>
          <code>{contentId}</code>
          <span>{outcome === "matched" ? "Matched" : outcome === "excluded" ? "Filtered out" : "Outside this list"}</span>
        </li>)}
      </ul>
      <details>
        <summary>Content before rules</summary>
        {result.ccre.beforeRules.length ? <ol>{result.ccre.beforeRules.map((id) => <li key={id}><code>{id}</code></li>)}</ol> : <p>No content</p>}
      </details>
    </div>}
  </div>;
}
