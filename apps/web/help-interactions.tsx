import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { adminPaths } from "../../packages/contracts/admin-paths";
import { fundingPreviewWorkflow } from "../../packages/contracts/funding-workflow";
import { pendingActionsContext } from "../../packages/contracts/workspace";
import { diagnosticHref } from "./admin-navigation";
import type { MarcusRun } from "./help-run-evidence";

type Exchange = { from: string; to: string; request: string; response: string };
type Stage = {
  id: string; label: string; owner: string; title: string; example: string;
  exchanges: Exchange[]; link: { label: string; href: string };
};
const pendingLogs = adminPaths.logs + "?source=" + pendingActionsContext;
const funding = fundingPreviewWorkflow.recommendation;
const stages: Stage[] = [
  {
    id: "welcome", label: "Sign in", owner: "App server", title: "What does Marcus see when he signs in?",
    example: "His account summary comes from account data. His pending actions come from a separate eligibility check.",
    exchanges: [
      {
        from: "App server", to: "Portfolio and goal services",
        request: "Marcus’s member ID (MID).",
        response: "His portfolio figures and savings goal for the welcome screen.",
      },
      {
        from: "App server", to: "Treatment Selector",
        request: "The same MID and the fixed topic pending-actions.",
        response: "Eligible reminders. An unfunded account qualifies for Preview funding before Marcus types a message.",
      },
    ],
    link: { label: "See pending-action decisions in Logs", href: pendingLogs },
  },
  {
    id: "intent", label: "Find the intent", owner: "App, sfield and LLM", title: "What does “I moved and need to update my address” mean?",
    example: "The app picks account help as the flow. Inside it, sfield asks the language model to identify the specific task.",
    exchanges: [
      {
        from: "App server", to: "Flow-selection model",
        request: "The message, recent chat from sfield and the flows enabled for this tenant, domain and audience.",
        response: "A flow ID that the app checks. Here it selects account help.",
      },
      {
        from: "sfield", to: "Treatment Selector",
        request: "First the active topics, then relevance scores for Marcus’s MID and those topics.",
        response: "The topic catalog and scores. The scores give the model a hint about likely topics.",
      },
      {
        from: "sfield", to: "Intent model",
        request: "Marcus’s words, recent turns, supported intents, topics and scores.",
        response: "The app checks the proposed intent update_address and topic address-update. An unclear message can lead to a question or a conversational reply.",
      },
    ],
    link: { label: "Inspect the routing exchanges", href: "#architecture" },
  },
  {
    id: "eligibility", label: "Check eligibility", owner: "Treatment Selector", title: "Why does Marcus also see a funding recommendation?",
    example: "His address request identifies the topic. The CCRE rule “Account is unfunded” determines whether he sees Preview funding.",
    exchanges: [
      {
        from: "sfield", to: "Account tools",
        request: "When the question refers to a specific account, read that account for this member. Alice can ask about “the second one” in her retirement account list.",
        response: "The selected account ID and its beneficiary record. General address guidance can skip this read.",
      },
      {
        from: "sfield", to: "Treatment Selector",
        request: "Marcus’s MID and the verified topic address-update. Alice’s account-specific check also carries her account ID.",
        response: "For Marcus, ranked content IDs, an eligible address action and a funding workflow ID and version. TS applies the customer rules.",
      },
      {
        from: "App server", to: "Content catalog",
        request: "Look up the eligible content IDs.",
        response: "Published copy, descriptions and required disclosures for the cards.",
      },
    ],
    link: { label: "Explore the rules and TS response", href: "#ts-sfield" },
  },
  {
    id: "render", label: "Build the reply", owner: "App and browser", title: "Where does the UI in chat come from?",
    example: "Marcus gets an address guide and a funding button. Asking for a calculator takes a different route and can work with an empty design library.",
    exchanges: [
      {
        from: "sfield", to: "Experience Composer (LLM)",
        request: "For an account-help reply, the verified intent and eligible content.",
        response: "A proposed reply and choice of components. The app validates them against the TS decision. With no eligible content, chat can still answer in words.",
      },
      {
        from: "App server", to: "Domain design library",
        request: "A matching published layout for the intent or capability.",
        response: "The app applies that layout to the verified result when available. Otherwise it keeps the built-in account cards.",
      },
      {
        from: "Custom UI flow", to: "Widget library and UI generator",
        request: "For example, “Build a savings calculator for $300 a month for 8 years.”",
        response: "A matching widget or a view assembled by server code from supported controls. A data-backed view without a connected source asks where the records should come from.",
      },
      {
        from: "App server", to: "Chat browser",
        request: "A validated A2UI message describing the components, values and available controls.",
        response: "React draws the supported controls. A slider can recalculate locally. A button that changes an account needs a registered action.",
      },
    ],
    link: { label: "Open the shared designs", href: adminPaths.builder + "?view=library" },
  },
  {
    id: "follow-up", label: "Follow up", owner: "Customer and sfield", title: "What happens when Marcus clicks Preview funding?",
    example: "The click starts a new turn linked to the original TS decision. Marcus can inspect funding methods before making a deposit.",
    exchanges: [
      {
        from: "Chat browser", to: "App server",
        request: "The issued action, component and surface IDs from the button.",
        response: "The app verifies the click and looks up the recommended workflow and its saved version.",
      },
      {
        from: "sfield", to: "Funding tools",
        request: "Run " + funding.id + "@" + funding.version + ". In ordered mode, use the steps saved in Tool setup. In agent mode, a model chooses among the allowed tools.",
        response: "Funding options, a question about the method, or a preview. Logs record each tool call and result.",
      },
      {
        from: "App server", to: "sfield chat history",
        request: "For a typed follow-up, read previous turns from this customer’s thread, including after they reopen it.",
        response: "A phrase like “show me the summary” after comparing balances can refer back to those balances.",
      },
      {
        from: "Customer chat", to: "Advisor workspace",
        request: "If the customer asks for a person, open a handoff with the conversation brief.",
        response: "The advisor and customer can exchange notes and see the same shared card.",
      },
    ],
    link: { label: "Inspect a recorded workflow click", href: "#ts-sfield" },
  },
  {
    id: "return", label: "Return later", owner: "Account portal and TS", title: "Why does the reminder disappear on Marcus’s next visit?",
    example: "Marcus’s first deposit counts as complete when the account portal confirms it. Extending this to Alice’s beneficiary update would require a confirmation from the retirement service.",
    exchanges: [
      {
        from: "Mock account portal", to: "Account store",
        request: "Record the first deposit for Marcus’s MID.",
        response: "A saved confirmation with the member ID, source, event ID and time. It carries across sign-ins.",
      },
      {
        from: "App server", to: "Treatment Selector",
        request: "At the next sign-in, Marcus’s MID and the pending-actions topic.",
        response: "TS now reads funded. The welcome screen drops the funding reminder.",
      },
      {
        from: "sfield", to: "Treatment Selector",
        request: "When Marcus asks “What’s next?”, his MID and the next-step topic.",
        response: "The unfunded rule excludes the reminder in chat too. Logs keep the original decision and the reason for the change.",
      },
    ],
    link: { label: "Inspect the new eligibility decision", href: pendingLogs },
  },
];

const stageAnchor = (stage: Stage) => "interaction-" + stage.id;
const stageAtLocation = () => stages.find((stage) => location.hash === "#" + stageAnchor(stage)) ?? stages[0];

export function InteractionMap({ run }: { run: MarcusRun }) {
  const [active, setActive] = useState(stageAtLocation);
  useEffect(() => {
    const sync = () => {
      if (location.hash === "#interactions" || location.hash.startsWith("#interaction-")) setActive(stageAtLocation());
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const source = run.selected;
  const click = source?.clicks.find((entry) => entry.kind === "workflow" && entry.id === funding.id && entry.version === funding.version);
  const recordedId = active.id === "follow-up" ? click?.turnId
    : ["intent", "eligibility", "render"].includes(active.id) ? source?.turnId : undefined;

  return <section id="interactions" className="help-section journey-map" aria-labelledby="interaction-map-title">
    <div className="help-section-heading">
      <div><h2 id="interaction-map-title">Customer interaction map</h2>
        <p>Follow Marcus from sign-in to his first deposit. Select a stage to see who calls whom and what comes back.</p>
      </div>
    </div>
    <div className="journey-frame">
      <p className="journey-setup"><strong>Before a visit</strong><span>Domain owners configure <a href={adminPaths.tools}>chat flows, TS rules and workflow tools</a> and publish reusable screens in <a href={adminPaths.builder}>UI Builder</a>.</span></p>
      <nav aria-label="Customer journey stages">
        <ol className="journey-stages">
          {stages.map((stage, i) => <li key={stage.id}>
            <a id={stageAnchor(stage)} href={"#" + stageAnchor(stage)} aria-current={active === stage ? "step" : undefined} aria-controls="interaction-detail">
              <span className="journey-step"><span>{i + 1}</span>{stage.label}</span>
              <small>{stage.owner}</small>
            </a>
          </li>)}
        </ol>
      </nav>
      <p className="journey-branch">A calculator can go from <a href="#interaction-intent">flow selection</a> straight to <a href="#interaction-render">building the UI</a>. An unclear request can end with a question.</p>
      <section id="interaction-detail" className="journey-detail" aria-labelledby="interaction-question">
        <h3 id="interaction-question">{active.title}</h3>
        <p>{active.example}</p>
        <table className="journey-exchanges" aria-label={"Exchanges for " + active.label}>
          <thead><tr><th scope="col">Who calls whom</th><th scope="col">Request</th><th scope="col">Response</th></tr></thead>
          <tbody>{active.exchanges.map(({ from, to, request, response }) => <tr key={from + to}>
            <th scope="row">{from} <ArrowRight size={13} aria-hidden="true" /><span className="sr-only"> to </span> {to}</th>
            <td><span className="journey-mobile-label" aria-hidden="true">Request</span>{request}</td>
            <td><span className="journey-mobile-label" aria-hidden="true">Response</span>{response}</td>
          </tr>)}</tbody>
        </table>
        <div className="journey-links">
          <a href={active.link.href}>{active.link.label} <ArrowUpRight size={14} aria-hidden="true" /></a>
          {source && recordedId && <a href={diagnosticHref(adminPaths.logs, source.threadId, recordedId)}>
            {active.id === "follow-up" ? "Marcus’s saved click in Logs" : "Marcus’s saved message in Logs"} <ArrowUpRight size={14} aria-hidden="true" />
          </a>}
        </div>
      </section>
    </div>
  </section>;
}
