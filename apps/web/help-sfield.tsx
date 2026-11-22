import { ArrowRight, ArrowUpRight, Database, Network, ShieldCheck, Sparkles } from "lucide-react";
import { sfieldTools, toolKeys, toolVersion, type ToolKey } from "../../packages/contracts/tool-setup";

const usage = {
  catalog: { caller: "Host · Discovery", contract: "discovery" },
  propensity: { caller: "Host · Discovery", contract: "discovery" },
  selection: { caller: "Host · Eligibility", contract: "treatment" },
  balances: { caller: "Experience Composer", contract: "balance" },
  glossary: { caller: "Host · Rule authoring", contract: "glossary" },
  portfolio: { caller: "Host · Portfolio summary", contract: "portfolio" },
  goal: { caller: "Host · Home-buying goal", contract: "goal" },
} satisfies Record<ToolKey, { caller: string; contract: string }>;

export function SfieldHelp({ selectContract }: { selectContract: (id: string) => void }) {
  const portfolioTool = sfieldTools.portfolio.id + "@" + toolVersion;
  return <section id="sfield" className="help-section" aria-labelledby="sfield-title">
    <div className="help-section-heading">
      <h2 id="sfield-title">sfield and plug-in tools</h2>
      <a className="help-section-link" href="#contracts" onClick={() => selectContract("rules")}>
        Tool setup contract <ArrowUpRight size={14} aria-hidden="true" />
      </a>
    </div>
    <div className="help-sfield">
      <p className="help-sfield-lead"><strong>sfield is the execution runtime for the chat turn.</strong> It runs configured model calls and registered tools.</p>
      <ol className="help-sfield-flow" aria-label="How sfield executes a turn" role="list">
        <li className="help-sfield-node">
          <span className="help-entity-icon"><Network size={18} aria-hidden="true" /></span>
          <h3>PZN host</h3>
          <p>Binds the conversation to a demo customer, chooses the next call, and verifies results before building the chat response.</p>
          <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
        </li>
        <li className="help-sfield-node">
          <span className="help-entity-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
          <h3>sfield runtime</h3>
          <p>Runs the router and composer, checks tool permissions and schemas, applies call limits and timeouts, and records run outcomes.</p>
          <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
        </li>
        <li className="help-sfield-targets">
          <div className="help-proposal-choice">
            <span className="help-entity-icon"><Sparkles size={16} aria-hidden="true" /></span>
            <div><h3>LLM gateway</h3><p>Returns an intent proposal or an experience proposal.</p></div>
          </div>
          <div className="help-proposal-choice">
            <span className="help-entity-icon"><Database size={16} aria-hidden="true" /></span>
            <div><h3>Registered tool handlers</h3><p>Call Treatment Selector or a data provider and return a structured result.</p></div>
          </div>
        </li>
      </ol>
      <div className="help-sfield-subsection">
        <h3>What makes a tool plug-and-play</h3>
        <p>Register a versioned ID, request and response schemas, a handler, and an execution policy. Grant access to the host scope or agent that uses the tool. The handler can delegate to a fixture or a connected service.</p>
        <div className="help-provider-path" aria-label="Portfolio Snapshot provider example">
          <div>
            <h4>Portfolio Snapshot tool</h4>
            <code>{portfolioTool}</code>
            <p>The host passes the turn and verified route. The handler resolves the member ID.</p>
          </div>
          <ArrowRight className="help-provider-arrow" size={20} aria-hidden="true" />
          <div>
            <h4>Provider implementation</h4>
            <code>PortfolioSnapshotProvider.read(mid, signal)</code>
            <p>The demo uses a fixture. To connect a service, supply an implementation through the server’s <code>portfolioSnapshots</code> option. It returns values such as cash, equities, and fixed income.</p>
          </div>
        </div>
      </div>
      <div className="help-sfield-subsection">
        <h3>Registered tools</h3>
        <p>The registered tools are read-only. Use Tool setup to enable or disable them and configure the Treatment Selector mock. Select a tool to see its contract.</p>
        <ul className="help-tool-registry" aria-label="sfield tool registry" role="list">
          {toolKeys.map((key) => {
            const tool = sfieldTools[key];
            return <li key={key}>
              <div className="help-tool-name">
                <a className="help-section-link" href="#contracts" onClick={() => selectContract(usage[key].contract)}>
                  {tool.label} <ArrowUpRight size={13} aria-hidden="true" />
                </a>
                <code>{tool.id}</code>
              </div>
              <p>{tool.description}</p>
              <span className="help-tool-caller">{usage[key].caller}</span>
            </li>;
          })}
        </ul>
      </div>
    </div>
  </section>;
}
