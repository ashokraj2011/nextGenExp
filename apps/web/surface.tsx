import "./published-ui.css";
import type { z } from "zod";
import { CapabilityForm, FactSummary, SavingsChart, SavingsMetric, formEnvelope } from "./agentic-experience";
import "./agentic.css";
import { Component, createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { A2uiSurface, createComponentImplementation, MarkdownComponentContext, type ReactCatalogComponent } from "@a2ui/react";
import {
  ActionMessageSchema, Catalog, CreateSurfaceMessageSchema, MessageProcessor, basicCatalog, injectBasicCatalogStyles,
  type ActionMessage, type CreateSurfaceMessage, type SurfaceModel,
} from "@a2ui/web_core/v1_0";
import { ArrowUpRight, BookOpenText, ChartNoAxesColumnIncreasing, ChevronDown, Columns2, FileText, House, ListChecks } from "lucide-react";
import { makeAssistantDataUI } from "@assistant-ui/react";
import type { FundingOptions, FundingPreview } from "../../packages/contracts/funding-workflow";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import {
  PZN_CATALOG_ID, FOLLOW_UP_EVENT, contentCard, comparison, stepList, metricSummary, experienceRoot, followUpButton, ruleCreation, portfolioSnapshot,
  capabilityForm, factSummary, layoutText, savingsChart, savingsMetric, fundingOptions, fundingPreview, goalProgressCard, validatePznSurface, type DisplayBlock, type DisplayExperience,
} from "../../packages/contracts/surface";
import { RuleCreationBlock } from "./rule-creation-block";
import { PortfolioSnapshotBlock } from "./portfolio-snapshot";
import { GoalProgressDetails } from "./goal-progress";

const icons = {
  PznContentCard: BookOpenText,
  PznComparison: Columns2,
  PznStepList: ListChecks,
  PznMetricSummary: ChartNoAxesColumnIncreasing,
  PznGoalProgress: House,
};
const blockLabels = {
  PznContentCard: "Explanation",
  PznComparison: "Comparison",
  PznStepList: "Step-by-step guide",
  PznMetricSummary: "Account balances",
  PznGoalProgress: "Home-buying goal",
};

function LayoutText({ heading, body, tone }: z.infer<typeof layoutText.schema>) {
  return <section className={"layout-text layout-text-" + tone}>
    {heading && <h3>{heading}</h3>}
    {body && <p>{body}</p>}
  </section>;
}

function RuleBlock(props: Extract<DisplayBlock, { component: "PznRuleCreation" }>["props"]) {
  const { preview } = useContext(SurfaceActions);
  return preview ? <section className="content-card">
    <h3>Create an eligibility rule</h3>
    <dl className="axe-facts">
      <div><dt>Context</dt><dd>Balances</dd></div>
      <div><dt>Content</dt><dd>Available balance</dd></div>
      <div><dt>Condition</dt><dd>Customer status</dd></div>
    </dl>
  </section> : <RuleCreationBlock {...props} />;
}

function surfaceClass({ layout, theme, preview }: { layout?: string; theme?: string; preview?: boolean }) {
  return "experience-flow" + (layout === "dashboard" ? " axe-dashboard" : "")
    + (theme === "evergreen" ? " published-ui" : "") + (preview ? " preview-ui" : "");
}

function FundingPreviewBlock({ amountCents, method }: FundingPreview) {
  const { enabled, preview } = useContext(SurfaceActions);
  return <section className="content-card" aria-label="Funding preview">
    <h3>Funding preview</h3>
    {!enabled && !preview && <p className="disclosure">Earlier preview</p>}
    <p className="content-body">{formatPortfolioAmount(amountCents)} by {method.label.toLowerCase()}</p>
    <dl className="compare-grid">
      <div className="compare-column"><dt>From</dt><dd>{method.from}</dd></div>
      <div className="compare-column"><dt>To</dt><dd>{method.to}</dd></div>
    </dl>
    <div className="content-footer"><p className="disclosure">The preview ends at review.</p></div>
  </section>;
}

function FundingOptionsBlock({ methods }: FundingOptions) {
  return <section className="content-card" aria-label="Funding options">
    <h3>Funding options</h3>
    <div className="compare-grid">
      {methods.map(({ methodId, label, from, to }) => <section key={methodId} className="compare-column">
        <h4>{label}</h4>
        <dl>
          <div><dt>From</dt><dd>{from}</dd></div>
          <div><dt>To</dt><dd>{to}</dd></div>
        </dl>
      </section>)}
    </div>
  </section>;
}

function ContentBlock({ block, form }: { block: DisplayBlock; form?: { experienceId: string; componentId: string; enabled: boolean } }) {
  const controls = useContext(ExperienceControls);
  if (block.component === savingsChart.name) return <SavingsChart {...block.props} />;
  if (block.component === savingsMetric.name) return <SavingsMetric {...block.props} />;
  if (block.component === factSummary.name) return <FactSummary {...block.props} />;
  if (block.component === capabilityForm.name) return form && <CapabilityForm props={block.props} enabled={form.enabled}
    dispatch={(id, values) => controls.followUp(form.experienceId, formEnvelope(form.experienceId, form.componentId, id, values))} />;
  if (block.component === layoutText.name) return <LayoutText {...block.props} />;
  if (block.component === ruleCreation.name) return <RuleBlock {...block.props} />;
  if (block.component === portfolioSnapshot.name) return <PortfolioSnapshotBlock {...block.props} />;
  if (block.component === fundingPreview.name) return <FundingPreviewBlock {...block.props} />;
  if (block.component === fundingOptions.name) return <FundingOptionsBlock {...block.props} />;
  const { component, props } = block;
  const Icon = icons[component];
  const recommendation = block.component === "PznContentCard" && block.props.recommendation;
  return (
    <section className={"content-card " + props.variant + (recommendation ? " suggested-next-step" : "")}
      aria-label={component === "PznGoalProgress" ? props.title : undefined}>
      <div className="content-kind"><Icon size={16} aria-hidden="true" />{recommendation ? "Suggested next step" : blockLabels[component]}</div>
      <h3>{props.title}</h3>
      {block.component === "PznContentCard" && (recommendation || block.props.variant === "expanded" ? (
        <p className="content-body">{block.props.body}</p>
      ) : (
        <>
          <p className="content-body">{block.props.description}</p>
          <details className="inline-details"><summary>Read the explanation <ChevronDown size={14} /></summary><p>{block.props.body}</p></details>
        </>
      ))}
      {block.component === "PznComparison" && (
        <div className="compare-grid" aria-label="Balance definitions">
          {block.props.columns.map(({ title, fields }) => (
            <section className="compare-column" key={title}>
              <h4>{title}</h4>
              <dl>
                {fields.map(({ fieldId, label, value }) => <div key={fieldId}><dt>{label}</dt><dd>{value}</dd></div>)}
              </dl>
            </section>
          ))}
        </div>
      )}
      {block.component === "PznStepList" && (
        <>
          <p className="content-body">{block.props.body}</p>
          <ol className="steps-list">
            {block.props.steps.map(({ stepId, title, body }) => <li key={stepId}><h4>{title}</h4><p>{body}</p></li>)}
          </ol>
        </>
      )}
      {block.component === "PznMetricSummary" && (
        <>
          <dl className="metric-grid">
            {block.props.values.map(({ metricKey, displayValue }) => (
              <div key={metricKey}>
                <dt>{metricKey === "available" ? "Available balance" : "Current balance"}</dt>
                <dd>{displayValue} <span>units</span></dd>
              </div>
            ))}
          </dl>
          <p className="metric-time">
            As of <time dateTime={block.props.observedAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(block.props.observedAt))}</time>
          </p>
        </>
      )}
      {block.component === goalProgressCard.name && <GoalProgressDetails goal={block.props.goal} />}
      <div className="content-footer">
        {props.disclosures.map((disclosure) => <p className="disclosure" key={disclosure}>{disclosure}</p>)}
        <details className="source-details">
          <summary><FileText size={14} />{props.sources.length === 1 ? "View source" : "View sources"} <ChevronDown size={14} /></summary>
          <ul>{props.sources.map(({ title, label, version, ref }) => (
            <li key={ref}><strong>{title}</strong><span>{label} · {version}</span></li>
          ))}</ul>
        </details>
      </div>
    </section>
  );
}

function Introduction({ intro, question, partial }: { intro: string; question: string | null; partial: boolean }) {
  return <>
    {question ? <p className="clarification">{question}</p> : <p className="experience-intro">{intro}</p>}
    {partial && <p className="partial-result">Some matching content is unavailable.</p>}
  </>;
}

const SurfaceActions = createContext({ enabled: false, preview: false });
const pznCatalog = new Catalog<ReactCatalogComponent>(PZN_CATALOG_ID, "1.0", [
  createComponentImplementation(experienceRoot, ({ props, buildChild }) => {
    const { preview } = useContext(SurfaceActions);
    const children = Array.isArray(props.children) ? props.children.map((child) => (
      typeof child === "string" ? { id: child, basePath: undefined } : child
    )) : [];
    const count = children.length - props.actionCount;
    const content = children.slice(0, count);
    const followUps = children.slice(count);
    return (
      <div className={surfaceClass({ ...props, preview })} data-renderer="a2ui">
        <Introduction intro={props.intro} question={props.question} partial={props.partial} />
        {content.map(({ id, basePath }) => <div className="surface-child" key={id}>{buildChild(id, basePath)}</div>)}
        {followUps.length > 0 && <div className="follow-up-list">{followUps.map(({ id, basePath }) => <div key={id}>{buildChild(id, basePath)}</div>)}</div>}
      </div>
    );
  }),
  createComponentImplementation(contentCard, ({ props }) => <ContentBlock block={{ component: contentCard.name, props }} />),
  createComponentImplementation(comparison, ({ props }) => <ContentBlock block={{ component: comparison.name, props }} />),
  createComponentImplementation(stepList, ({ props }) => <ContentBlock block={{ component: stepList.name, props }} />),
  createComponentImplementation(metricSummary, ({ props }) => <ContentBlock block={{ component: metricSummary.name, props }} />),
  createComponentImplementation(goalProgressCard, ({ props }) => <ContentBlock block={{ component: goalProgressCard.name, props }} />),
  createComponentImplementation(portfolioSnapshot, ({ props }) => <PortfolioSnapshotBlock {...props} />),
  createComponentImplementation(fundingPreview, ({ props }) => <FundingPreviewBlock {...props} />),
  createComponentImplementation(fundingOptions, ({ props }) => <FundingOptionsBlock {...props} />),
  createComponentImplementation(ruleCreation, ({ props }) => <RuleBlock {...props} />),
  createComponentImplementation(layoutText, ({ props }) => <LayoutText {...props} />),
  createComponentImplementation(savingsChart, ({ props }) => <SavingsChart {...props} />),
  createComponentImplementation(savingsMetric, ({ props }) => <SavingsMetric {...props} />),
  createComponentImplementation(factSummary, ({ props }) => <FactSummary {...props} />),
  createComponentImplementation(capabilityForm, ({ props, context }) => {
    const { enabled } = useContext(SurfaceActions);
    return <CapabilityForm props={props} enabled={enabled}
      dispatch={(actionId, values) => void context.dispatchAction({ event: { name: FOLLOW_UP_EVENT, context: { actionId, values } } }).catch(() => undefined)} />;
  }),
  createComponentImplementation(followUpButton, ({ props, context }) => {
    const { enabled } = useContext(SurfaceActions);
    return <button className="follow-up" type="button" disabled={!enabled} onClick={() => {
      void context.dispatchAction({ event: { name: FOLLOW_UP_EVENT, context: { actionId: props.actionId } } }).catch(() => undefined);
    }}>{props.label}</button>;
  }),
]);

export function installA2uiStyles() {
  injectBasicCatalogStyles();
}
function PlainText({ markdown }: { markdown: string }) {
  return <span>{markdown}</span>;
}

function MountedSurface({ input, id, onAction, smoke, onRendered }: {
  input: unknown;
  id: string;
  onAction: (action: ActionMessage) => void;
  smoke?: boolean;
  onRendered?: () => void;
}) {
  const [surface, setSurface] = useState<SurfaceModel<ReactCatalogComponent>>();
  const [error, setError] = useState<Error | null>(null);
  const callbacks = useRef({ onAction, onRendered });
  callbacks.current = { onAction, onRendered };
  useEffect(() => {
    let message: CreateSurfaceMessage;
    const processor = new MessageProcessor<ReactCatalogComponent>(
      smoke ? [basicCatalog] : [pznCatalog],
      (action) => { callbacks.current.onAction(ActionMessageSchema.parse({ version: "1.0", action })); },
    );
    try {
      message = smoke ? CreateSurfaceMessageSchema.parse(input) : validatePznSurface(input, id);
      processor.processMessages([message]);
      const created = processor.getSurface(id);
      if (!created) throw new Error("A2UI surface is missing");
      setSurface(created);
    } catch (reason) {
      processor.dispose();
      setError(reason instanceof Error ? reason : new Error("A2UI surface failed"));
      return;
    }
    return () => {
      try { processor.processMessages([{ version: "1.0", deleteSurface: { surfaceId: id } }]); }
      finally { processor.dispose(); }
    };
  }, [id, input, smoke]);

  useEffect(() => {
    if (surface) callbacks.current.onRendered?.();
  }, [surface]);
  if (error) throw error;
  return surface ? <MarkdownComponentContext.Provider value={PlainText}><A2uiSurface surface={surface} /></MarkdownComponentContext.Provider> : null;
}

class SurfaceBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { fallback: boolean }> {
  state = { fallback: false };
  static getDerivedStateFromError() { return { fallback: true }; }
  render() { return this.state.fallback ? this.props.fallback : this.props.children; }
}
type SurfaceControls = {
  activeExperienceId?: string;
  followUp: (id: string, envelope: ActionMessage) => void;
  rendered: (id: string, fallback?: boolean) => void;
};
export const ExperienceControls = createContext<SurfaceControls>({
  followUp: () => undefined, rendered: () => undefined,
});

function CanonicalFallback({ experience, enabled }: { experience: DisplayExperience; enabled: boolean }) {
  const controls = useContext(ExperienceControls);
  const { experienceId } = experience;
  const { preview } = useContext(SurfaceActions);
  const rendered = useRef(controls.rendered);
  rendered.current = controls.rendered;
  useEffect(() => rendered.current(experienceId, true), [experienceId]);
  return <div className={surfaceClass({ ...experience, preview })} data-renderer="fallback">
    <Introduction intro={experience.intro} question={experience.question} partial={experience.partial} />
    {experience.blocks.map((block, index) => <ContentBlock key={index} block={block} form={{ experienceId, componentId: "block_" + (index + 1), enabled }} />)}
    {experience.actions.length > 0 && <div className="follow-up-list">
      {experience.actions.map(({ actionId, componentId, label }) => (
        <button key={actionId} type="button" className="follow-up" disabled={!enabled} onClick={() => (
          controls.followUp(experienceId, {
            version: "1.0", action: {
              name: FOLLOW_UP_EVENT, surfaceId: experienceId, sourceComponentId: componentId,
              timestamp: new Date().toISOString(), context: { actionId },
            },
          })
        )}>{label}</button>
      ))}
    </div>}
  </div>;
}

function ExperiencePart({ data, preview = false }: { data: DisplayExperience; preview?: boolean }) {
  const { experienceId, messages, expiresAt } = data;
  const controls = useContext(ExperienceControls);
  const [expired, setExpired] = useState(() => Date.now() >= expiresAt);
  useEffect(() => {
    const delay = expiresAt - Date.now();
    if (delay <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), delay);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const enabled = !preview && controls.activeExperienceId === experienceId && !expired;
  return <SurfaceActions.Provider value={{ enabled, preview }}>
    <SurfaceBoundary key={experienceId} fallback={<CanonicalFallback experience={data} enabled={enabled} />}>
      <MountedSurface id={experienceId} input={messages[0]}
        onAction={(envelope) => controls.followUp(experienceId, envelope)}
        onRendered={() => controls.rendered(experienceId)} />
    </SurfaceBoundary>
  </SurfaceActions.Provider>;
}
export function ExperienceLayoutPreview({ data }: { data: DisplayExperience }) {
  return <ExperiencePart data={data} preview />;
}

export const ExperienceDataUI = makeAssistantDataUI<DisplayExperience>({ name: "experience-surface", render: ExperiencePart });

export function BasicSmoke({ input }: { input: CreateSurfaceMessage }) {
  const [action, setAction] = useState<ActionMessage>();
  return <main className="smoke-page">
    <p className="test-label">Automated test mode</p>
    <SurfaceBoundary fallback={<p role="alert">Smoke render failed.</p>}>
      <MountedSurface id={input.createSurface.surfaceId} input={input} smoke onAction={setAction} />
    </SurfaceBoundary>
    {action && <output data-testid="a2ui-action"><ArrowUpRight aria-hidden="true" size={14} />{JSON.stringify(action)}</output>}
  </main>;
}
