import { ArrowRight, ArrowUpRight, Database, Network, ShieldCheck, Sparkles } from "lucide-react";
import { sfieldTools, toolKeys, toolVersion, type ToolKey } from "../../packages/contracts/tool-setup";

const usage = {
  catalog: { caller: "App · Before the first model call", contract: "discovery", description: "Gets the active topics from the mock Treatment Selector." },
  propensity: { caller: "App · Before the first model call", contract: "discovery", description: "Asks Treatment Selector for the customer’s scores for the active topics." },
  selection: { caller: "App · Finds eligible treatments", contract: "treatment", description: "Returns eligible content and the funding workflow for the address demo when its rule matches." },
  balances: { caller: "Experience Composer", contract: "balance", description: "Looks up the customer’s sample balances." },
  glossary: { caller: "App · Creates a rule", contract: "glossary", description: "Lists the fields and comparisons you can use in a rule." },
  portfolio: { caller: "App · Summarizes a portfolio", contract: "portfolio", description: "Looks up what the demo customer holds in their portfolio." },
  goal: { caller: "App · Shows goal progress", contract: "goal", description: "Looks up the down payment target and monthly savings." },
  fundingOptions: { caller: "Funding preview workflow", contract: "funding", description: "Reads the sample funding method and amount." },
  fundingStatus: { caller: "Funding preview workflow · Optional", contract: "funding", description: "Checks whether the demo account is awaiting its first deposit." },
  fundingPreview: { caller: "Funding preview workflow", contract: "funding", description: "Builds a sample preview using the method read for this turn." },
} satisfies Record<ToolKey, { caller: string; contract: string; description: string }>;

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
      <p className="help-sfield-lead"><strong>sfield runs the model calls and tools needed to answer a chat message.</strong></p>
      <ol className="help-sfield-flow" aria-label="How sfield handles a chat message" role="list">
        <li className="help-sfield-node">
          <span className="help-entity-icon"><Network size={18} aria-hidden="true" /></span>
          <h3>PZN app server</h3>
          <p>Matches the chat to a demo customer, chooses the next step, and checks the results before building the reply.</p>
          <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
        </li>
        <li className="help-sfield-node">
          <span className="help-entity-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
          <h3>sfield</h3>
          <p>Checks who can use a tool and whether the data is in the right format. It limits how long calls can run and records what happened.</p>
          <ArrowRight className="help-proposal-arrow" size={22} aria-hidden="true" />
        </li>
        <li className="help-sfield-targets">
          <div className="help-proposal-choice">
            <span className="help-entity-icon"><Sparkles size={16} aria-hidden="true" /></span>
            <div><h3>Language model</h3><p>Identifies the request or suggests how to show the answer.</p></div>
          </div>
          <div className="help-proposal-choice">
            <span className="help-entity-icon"><Database size={16} aria-hidden="true" /></span>
            <div><h3>Tools</h3><p>Ask Treatment Selector which content fits or look up the account details needed for the reply.</p></div>
          </div>
        </li>
      </ol>
      <div className="help-sfield-subsection">
        <h3>What makes a tool plug-and-play</h3>
        <p>Each tool has an ID and version, a format for what it receives and sends back, code that does the work, and rules for who can use it. The code can get its data from the demo or a connected service.</p>
        <div className="help-provider-path" aria-label="Portfolio Snapshot provider example">
          <div>
            <h4>Portfolio Snapshot tool</h4>
            <code>{portfolioTool}</code>
            <p>The app identifies the chat request and its approved route. The tool uses that to find the right member ID.</p>
          </div>
          <ArrowRight className="help-provider-arrow" size={20} aria-hidden="true" />
          <div>
            <h4>Where the data comes from</h4>
            <code>PortfolioSnapshotProvider.read(mid, signal)</code>
            <p>The demo uses sample data. Set the server’s <code>portfolioSnapshots</code> option to connect a service that provides cash and investment balances.</p>
          </div>
        </div>
      </div>
      <div className="help-sfield-subsection">
        <h3>Registered tools</h3>
        <p>These tools only read data. Use Tool setup to turn them on or off and choose how Treatment Selector responds in the demo. Select a tool to see what it sends and receives.</p>
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
              <p>{usage[key].description}</p>
              <span className="help-tool-caller">{usage[key].caller}</span>
            </li>;
          })}
        </ul>
      </div>
    </div>
  </section>;
}
