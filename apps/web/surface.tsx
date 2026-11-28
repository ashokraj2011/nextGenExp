import "./published-ui.css";
import type { z } from "zod";
import { CapabilityForm, FactSummary, LiveSimulationProvider, SavingsChart, SavingsMetric, formEnvelope } from "./agentic-experience";
import "./agentic.css";
import { RichText, renderInlineMarkdown } from "./markdown";
import { Component, createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { A2uiSurface, createComponentImplementation, MarkdownComponentContext, type ReactCatalogComponent } from "@a2ui/react";
import {
  ActionMessageSchema, Catalog, CreateSurfaceMessageSchema, MessageProcessor, basicCatalog, injectBasicCatalogStyles,
  type ActionMessage, type CreateSurfaceMessage, type SurfaceModel,
} from "@a2ui/web_core/v1_0";
import { ArrowRight, ArrowUpRight, BookOpenText, ChartNoAxesColumnIncreasing, ChevronDown, Columns2, FileText, House, ListChecks } from "lucide-react";
import { makeAssistantDataUI } from "@assistant-ui/react";
import type { FundingOptions, FundingPreview } from "../../packages/contracts/funding-workflow";
import type { GoalSavingsProjection } from "../../packages/contracts/goal-progress";
import { accountPortalPath } from "../../packages/contracts/workspace";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import {
  PZN_CATALOG_ID, FOLLOW_UP_EVENT, boundWidget, widgetWizard, contentCard, comparison, stepList, metricSummary, experienceRoot, followUpButton, ruleCreation, portfolioSnapshot,
  capabilityForm, customForm, factSummary, layoutText, dynamicCanvas, savingsChart, savingsMetric, fundingOptions, fundingPreview, goalProgressCard, retirementAccounts, validatePznSurface, type DisplayBlock, type DisplayExperience,
} from "../../packages/contracts/surface";
import { DynamicCanvasBlock } from "./dynamic-canvas";
import { PortfolioSnapshotBlock } from "./portfolio-snapshot";
import { GoalProgressDetails } from "./goal-progress";
import { StreamingRichText } from "./live-grounding";
import { VerifiedProvenanceBadge } from "./verified-provenance";
import { DepositConfirmation } from "./workspace-actions";

export const LiveReplyContext = createContext(false);

const RuleCreationBlock = lazy(() => import("./rule-creation-block").then(({ RuleCreationBlock }) => ({ default: RuleCreationBlock })));

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

function initialFormValues(fields: z.infer<typeof customForm.schema>["fields"]) {
  const initial: Record<string, string | boolean> = {};
  for (const f of fields) {
    if (f.type === "checkbox") initial[f.id] = f.initialValue === "true" || f.initialValue === "on_file" || f.initialValue === "funded";
    else if (f.type === "select") initial[f.id] = f.initialValue && f.options.includes(f.initialValue) ? f.initialValue : (f.options[0] ?? "");
    else initial[f.id] = f.initialValue ?? "";
  }
  return initial;
}

function CustomFormBlock({ title, description, submitLabel, writeBack = true, fields }: z.infer<typeof customForm.schema>) {
  const { enabled, preview } = useContext(SurfaceActions);
  const controls = useContext(ExperienceControls);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialFormValues(fields));
  const [submitted, setSubmitted] = useState<{ summary: string; savedFields: string[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [missingError, setMissingError] = useState("");
  const fieldsSignature = fields.map((f) => `${f.id}:${f.type}:${f.initialValue ?? ""}`).join("|");
  useEffect(() => {
    setValues(initialFormValues(fields));
  }, [fieldsSignature]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const missing = fields.filter((f) => {
      if (!f.required) return false;
      const val = values[f.id];
      return f.type === "checkbox" ? val !== true : !String(val ?? "").trim();
    });
    if (missing.length > 0) {
      setMissingError(`Please complete: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    setMissingError("");
    const parts = fields.map((f) => {
      const val = values[f.id];
      const formatted = f.type === "checkbox" ? (val ? "Yes" : "No")
        : f.type === "currency" && String(val ?? "").trim() ? `$${String(val).replace(/^\$/, "")}`
        : String(val ?? "—");
      return `${f.label}: ${formatted}`;
    });
    const summary = parts.join(" · ");
    const updates: Record<string, string> = {};
    if (writeBack !== false) {
      for (const f of fields) {
        if (!f.defaultBinding) continue;
        const val = values[f.id];
        const raw = f.type === "checkbox" ? String(Boolean(val)) : String(val ?? "").trim();
        if (raw) updates[f.defaultBinding] = raw;
      }
    }
    const updateKeys = Object.keys(updates);
    if (preview) {
      setSubmitted({ summary, savedFields: updateKeys });
      return;
    }
    setSubmitting(true);
    let savedFields: string[] = [];
    try {
      if (updateKeys.length > 0) {
        if (!controls.onWriteBack) throw new Error("Saving is unavailable for this form.");
        savedFields = await controls.onWriteBack(updates);
        if (updateKeys.some((key) => !savedFields.includes(key))) throw new Error("The changes were not confirmed.");
      }
    } catch (error) {
      setMissingError((error instanceof Error ? error.message + " " : "") + "Your entries are still here. Review them and try saving again.");
      return;
    } finally {
      setSubmitting(false);
    }
    setSubmitted({ summary, savedFields });
    if (enabled && controls.askPrompt) {
      const note = savedFields.length > 0 ? " (Updated Customer 360 profile)" : "";
      controls.askPrompt(`Submitted "${title || "Form"}" — ${summary}${note}`);
    }
  }

  return (
    <section className="content-card pzn-custom-form" aria-label={title || "Interactive form"}>
      <div className="content-kind"><ListChecks size={16} aria-hidden="true" />Interactive form</div>
      {title && <h3>{title}</h3>}
      {description && <p className="pzn-custom-form-desc">{description}</p>}
      {submitted ? (
        <div className="pzn-custom-form-done" role="status">
          <strong>
            {preview
              ? (submitted.savedFields.length > 0 ? `Preview submitted · Will update Customer 360 (${submitted.savedFields.join(", ")})` : "Preview form submitted")
              : (submitted.savedFields.length > 0 ? `Saved to Customer 360 (${submitted.savedFields.join(", ")})` : "Submitted")}
          </strong>
          <p>{submitted.summary}</p>
          {preview && (
            <button type="button" className="secondary-button" onClick={() => setSubmitted(null)}>Reset preview form</button>
          )}
        </div>
      ) : (
        <form className="pzn-custom-form-grid" onSubmit={(e) => void handleSubmit(e)}>
          {fields.length === 0 ? (
            <p className="pzn-custom-form-empty">Add fields in the form editor to preview them here.</p>
          ) : fields.map((field) => {
            const val = values[field.id];
            if (field.type === "checkbox") {
              return (
                <label key={field.id} className="pzn-cf-checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(val)}
                    disabled={!preview && !enabled}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.checked }))}
                  />
                  <span>{field.label}{field.required ? " *" : ""}</span>
                </label>
              );
            }
            return (
              <label key={field.id} className="pzn-cf-field">
                <span>{field.label}{field.required ? " *" : ""}</span>
                {field.type === "select" ? (
                  <select
                    value={String(val ?? "")}
                    disabled={!preview && !enabled}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  >
                    {field.options.length === 0 && <option value="">Select an option</option>}
                    {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : field.type === "currency" ? (
                  <div className="pzn-cf-currency">
                    <span aria-hidden="true">$</span>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={String(val ?? "")}
                      placeholder={field.placeholder || "0.00"}
                      disabled={!preview && !enabled}
                      onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                    />
                  </div>
                ) : (
                  <input
                    type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
                    value={String(val ?? "")}
                    placeholder={field.placeholder}
                    disabled={!preview && !enabled}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  />
                )}
              </label>
            );
          })}
          {missingError && <p className="pzn-cf-error" role="alert">{missingError}</p>}
          {fields.length > 0 && (
            <div className="pzn-cf-actions">
              <button type="submit" className="axe-primary-button" disabled={submitting || (!preview && !enabled)}>
                {submitLabel || "Submit"}
              </button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}

type WidgetNavigation = {
  position: string;
  heading: Ref<HTMLHeadingElement>;
  back?: () => void;
  next?: () => void;
};

function BoundWidgetBlock({
  badge, title, body, accentTop, hydratedFor, metrics, progressLabel, progressPercent, progressDisplay, ctaLabel, ctaPrompt, navigation,
}: z.infer<typeof boundWidget.schema> & { navigation?: WidgetNavigation }) {
  const { enabled, preview } = useContext(SurfaceActions);
  const controls = useContext(ExperienceControls);
  const hasBindings = metrics.some((m) => Boolean(m.boundKey)) || progressPercent !== undefined;
  const buttonLabel = navigation?.next ? ctaLabel || "Continue" : (!navigation || ctaPrompt ? ctaLabel : undefined);

  return (
    <section className={"content-card pzn-bound-widget" + (accentTop ? " has-accent-top" : "")} aria-label={title}>
      <div className="pzn-bw-top">
        {badge && <span className="pzn-bw-badge">{badge}</span>}
        {hasBindings && hydratedFor && (
          <span className="pzn-bw-live-pill">Live data · {hydratedFor}</span>
        )}
      </div>
      {navigation && <p className="pzn-bw-step" aria-live="polite">{navigation.position}</p>}
      <h3 ref={navigation?.heading} tabIndex={navigation ? -1 : undefined}>{title}</h3>
      {body && <p className="pzn-bw-body">{body}</p>}
      {metrics.length > 0 && (
        <dl className="pzn-bw-metrics">
          {metrics.map((metric) => (
            <div key={metric.id} className={"pzn-bw-metric tone-" + metric.tone}>
              <dt>{metric.label}</dt>
              <dd>
                <strong>{metric.value}</strong>
                {metric.subtext && <span>{metric.subtext}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {progressPercent !== undefined && (
        <div className="pzn-bw-progress">
          <div className="pzn-bw-progress-head">
            <span>{progressLabel || "Progress"}</span>
            <strong>{progressDisplay ?? `${progressPercent}%`}</strong>
          </div>
          <div className="pzn-bw-progress-track" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
          </div>
        </div>
      )}
      {(buttonLabel || navigation?.back) && (
        <div className="pzn-bw-actions">
          {navigation?.back && <button type="button" className="secondary-button" onClick={navigation.back}>Back</button>}
          {buttonLabel && <button
            type="button"
            className="axe-primary-button"
            disabled={!navigation?.next && !preview && !enabled}
            onClick={navigation?.next ?? (() => {
              if (!preview && enabled && ctaPrompt && controls.askPrompt) controls.askPrompt(ctaPrompt);
            })}
          >
            {buttonLabel} {navigation?.next ? <ArrowRight size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}
          </button>}
        </div>
      )}
    </section>
  );
}

function WidgetWizardBlock({ wizardId, steps }: z.infer<typeof widgetWizard.schema>) {
  const { experienceId, preview } = useContext(SurfaceActions);
  const storageKey = preview ? undefined : `pzn.widget-step:${experienceId}:${wizardId}`;
  const [step, setStep] = useState(() => {
    if (!storageKey) return 0;
    try {
      const saved = Number(sessionStorage.getItem(storageKey));
      return Number.isInteger(saved) && saved >= 0 && saved < steps.length ? saved : 0;
    } catch { return 0; }
  });
  const current = Math.min(step, steps.length - 1);
  const heading = useRef<HTMLHeadingElement>(null);
  const didNavigate = useRef(false);
  useLayoutEffect(() => {
    if (didNavigate.current) heading.current?.focus();
  }, [current]);

  function open(next: number) {
    didNavigate.current = true;
    setStep(next);
    if (storageKey) {
      try { sessionStorage.setItem(storageKey, String(next)); } catch { /* Navigation still works in memory. */ }
    }
  }

  return <BoundWidgetBlock {...steps[current]} navigation={{
    position: `Step ${current + 1} of ${steps.length}`,
    heading,
    ...(current > 0 && { back: () => open(current - 1) }),
    ...(current < steps.length - 1 && { next: () => open(current + 1) }),
  }} />;
}

function RuleBlock(props: Extract<DisplayBlock, { component: "PznRuleCreation" }>["props"]) {
  const { preview } = useContext(SurfaceActions);
  const { allowRuleCreation } = useContext(ExperienceControls);
  if (!preview && !allowRuleCreation) return null;
  return preview ? <section className="content-card">
    <h3>Create an eligibility rule</h3>
    <dl className="axe-facts">
      <div><dt>Context</dt><dd>Balances</dd></div>
      <div><dt>Content</dt><dd>Available balance</dd></div>
      <div><dt>Condition</dt><dd>Customer status</dd></div>
    </dl>
  </section> : <Suspense fallback={<p role="status">Loading rule editor…</p>}><RuleCreationBlock {...props} /></Suspense>;
}

function surfaceClass({ layout, theme, preview }: { layout?: string; theme?: string; preview?: boolean }) {
  return "experience-flow" + (layout === "dashboard" ? " axe-dashboard" : "")
    + (theme === "evergreen" ? " published-ui" : "") + (preview ? " preview-ui" : "");
}

function FundingPortalLink() {
  const { enabled, preview, experienceId } = useContext(SurfaceActions);
  const { accountFunding } = useContext(ExperienceControls);
  if (preview || !accountFunding || accountFunding.completion) return null;
  if (!enabled && !(experienceId === accountFunding.latestExperienceId && accountFunding.canResume)) return null;
  const query = new URLSearchParams({ conversationId: accountFunding.conversationId });
  return <a className="overview-action" href={accountPortalPath + "?" + query}>Open account portal <ArrowUpRight size={15} aria-hidden="true" /></a>;
}

function FundingCard({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const { completedFunding } = useContext(SurfaceActions);
  return <section className="content-card" aria-label={title}>
    <h3>{completedFunding ? "Account funding" : title}</h3>
    {completedFunding ? <>
      <div className="funding-receipt"><DepositConfirmation confirmedAt={completedFunding.confirmedAt} /></div>
      <details className="inline-details funding-history">
        <summary>View earlier {title.toLowerCase()}</summary>
        {children}
      </details>
    </> : <>
      {children}
      <div className="content-footer">{note && <p className="disclosure">{note}</p>}<FundingPortalLink /></div>
    </>}
  </section>;
}

function FundingPreviewBlock({ amountCents, method }: FundingPreview) {
  const { enabled, preview, completedFunding } = useContext(SurfaceActions);
  return <FundingCard title="Funding preview" note="The preview ends at review.">
    {!enabled && !preview && !completedFunding && <p className="disclosure">Earlier preview</p>}
    <p className="content-body">{formatPortfolioAmount(amountCents)} by {method.label.toLowerCase()}</p>
    <dl className="compare-grid">
      <div className="compare-column"><dt>From</dt><dd>{method.from}</dd></div>
      <div className="compare-column"><dt>To</dt><dd>{method.to}</dd></div>
    </dl>
  </FundingCard>;
}

function RetirementAccountsCard(view: z.infer<typeof retirementAccounts.schema>) {
  const { enabled } = useContext(SurfaceActions);
  const { askPrompt } = useContext(ExperienceControls);
  const { selected } = view;
  return <section className="content-card retirement-accounts-card" aria-label={view.title}>
    <h3>{view.title}</h3>
    {selected ? <>
      <p className="retirement-account-ending">Account ending in {selected.id.slice(-4)}</p>
      <dl className="retirement-designation"><dt>Primary beneficiary</dt><dd>{selected.beneficiary ?? "No beneficiary on file"}</dd></dl>
    </> : view.accounts.length ? <ol aria-label="Retirement accounts in display order">
      {view.accounts.map((account) => <li key={account.id}>
        <button type="button" disabled={!enabled || !askPrompt} onClick={() => askPrompt?.(`Who's the beneficiary on my ${account.label} ending in ${account.id.slice(-4)}?`)}>
          <span><strong>{account.label}</strong><small>Ending in {account.id.slice(-4)}</small></span><ArrowUpRight size={16} aria-hidden="true" />
        </button>
      </li>)}
    </ol> : <p>Your retirement accounts will appear here when one is linked.</p>}
  </section>;
}

function FundingOptionsBlock({ methods }: FundingOptions) {
  return <FundingCard title="Funding options">
    <div className="compare-grid">
      {methods.map(({ methodId, label, from, to }) => <section key={methodId} className="compare-column">
        <h4>{label}</h4>
        <dl>
          <div><dt>From</dt><dd>{from}</dd></div>
          <div><dt>To</dt><dd>{to}</dd></div>
        </dl>
      </section>)}
    </div>
  </FundingCard>;
}

function ChatPortfolio(props: z.infer<typeof portfolioSnapshot.schema>) {
  const { askPrompt } = useContext(ExperienceControls);
  const { pendingPortfolio } = useContext(SurfaceActions);
  return <PortfolioSnapshotBlock {...props} onExploreAllocation={askPrompt} allowSimulation={pendingPortfolio || Boolean(askPrompt)} />;
}

type ComparisonProps = z.infer<typeof comparison.schema>;

function CardSources({ sources, disclosures }: Pick<ComparisonProps, "sources" | "disclosures">) {
  return <div className="content-footer">
    {disclosures.map((disclosure) => <p className="disclosure" key={disclosure}>{disclosure}</p>)}
    <details className="source-details">
      <summary><FileText size={14} aria-hidden="true" />{sources.length === 1 ? "View source" : "View sources"} <ChevronDown size={14} aria-hidden="true" /></summary>
      <ul>{sources.map(({ title, label, version, ref }) => (
        <li key={ref}><strong>{title}</strong><span>{label} · {version}</span></li>
      ))}</ul>
    </details>
  </div>;
}

function BalanceComparisonCard({ columns, sources, disclosures }: ComparisonProps) {
  return <section className="content-card balance-comparison">
    <h3>Available vs. current balance</h3>
    <p className="content-body">Check your available balance to see how much you can use now.</p>
    <dl className="compare-grid" aria-label="Balance definitions">
      {columns.map(({ title, fields }) => <div className="compare-column" key={title}>
        <dt>{title}</dt>
        <dd>{fields.find(({ fieldId }) => fieldId === "meaning")?.value ?? fields[0].value}</dd>
      </div>)}
    </dl>
    <CardSources sources={sources} disclosures={disclosures} />
  </section>;
}

function ContentBlock({ block, form, onAction }: {
  block: DisplayBlock; form?: { experienceId: string; componentId: string; enabled: boolean }; onAction?: (id: string) => void;
}) {
  const controls = useContext(ExperienceControls);
  const { balanceComparison, experienceId } = useContext(SurfaceActions);
  const inlineAction = onAction ?? (form?.enabled ? (actionId: string) => controls.followUp(form.experienceId, {
    version: "1.0", action: { name: FOLLOW_UP_EVENT, surfaceId: form.experienceId, sourceComponentId: form.componentId,
      timestamp: new Date().toISOString(), context: { actionId } },
  }) : undefined);
  if (balanceComparison && block.component === comparison.name) return <BalanceComparisonCard {...block.props} />;
  if (block.component === retirementAccounts.name) return <RetirementAccountsCard {...block.props} />;
  if (block.component === savingsChart.name) return <SavingsChart {...block.props} />;
  if (block.component === savingsMetric.name) return <SavingsMetric {...block.props} />;
  if (block.component === factSummary.name) return <FactSummary {...block.props} />;
  if (block.component === capabilityForm.name) return form && <CapabilityForm props={block.props} enabled={form.enabled}
    dispatch={(id, values) => controls.followUp(form.experienceId, formEnvelope(form.experienceId, form.componentId, id, values))} />;
  if (block.component === layoutText.name) return <LayoutText {...block.props} />;
  if (block.component === customForm.name) return <CustomFormBlock {...block.props} />;
  if (block.component === boundWidget.name) return <BoundWidgetBlock {...block.props} />;
  if (block.component === widgetWizard.name) return <WidgetWizardBlock {...block.props} />;
  if (block.component === dynamicCanvas.name) return <DynamicCanvasBlock {...block.props} onFollowUp={controls.askPrompt}
    onAction={inlineAction} />;
  if (block.component === ruleCreation.name) return <RuleBlock {...block.props} />;
  if (block.component === portfolioSnapshot.name) return <ChatPortfolio {...block.props} />;
  if (block.component === fundingPreview.name) return <FundingPreviewBlock {...block.props} />;
  if (block.component === fundingOptions.name) return <FundingOptionsBlock {...block.props} />;
  const { component, props } = block;
  const Icon = icons[component];
  const recommendation = block.component === "PznContentCard" && block.props.recommendation;
  const savingsOption = block.component === goalProgressCard.name ? block.props.savingsOption : undefined;
  return (
    <section className={"content-card " + props.variant + (recommendation ? " suggested-next-step" : "")}
      aria-label={component === "PznGoalProgress" ? props.title : undefined}
      data-goal-scenario-chart={savingsOption ? experienceId : undefined}>
      <div className="card-kind-row">
        <div className="content-kind"><Icon size={16} aria-hidden="true" />{recommendation ? "Suggested next step" : blockLabels[component]}</div>
        {block.component === goalProgressCard.name && (
          <VerifiedProvenanceBadge toolRef="goal.progress.read@1.0.0" domain="wealth" />
        )}
        {block.component === "PznMetricSummary" && (
          <VerifiedProvenanceBadge toolRef="demo.balance.read@1.0.0" domain="wealth" observedAt={block.props.observedAt} />
        )}
      </div>
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
      {block.component === goalProgressCard.name && <GoalProgressDetails goal={block.props.goal}
        projection={savingsOption ? controls.goalScenarios?.get(experienceId) : undefined}
        extraMonthlyCents={savingsOption?.extraMonthlyCents}
        onPreview={savingsOption && inlineAction ? () => inlineAction(savingsOption.actionId) : undefined}
        onExplorePrompt={controls.askPrompt} />}
      <CardSources sources={props.sources} disclosures={props.disclosures} />
    </section>
  );
}

function Introduction({ intro, question, partial }: { intro: string; question: string | null; partial: boolean }) {
  const { balanceComparison, completedFunding } = useContext(SurfaceActions);
  const liveReply = useContext(LiveReplyContext);
  if (completedFunding) return null;
  const genericComparisonIntro = /^(?:(?:Hi [^,]+,|Thanks for asking, [^—]+ —)\s*)?here[’']s (?:how the terms compare|a comparison)\.$/i;
  const showIntro = Boolean(intro.trim()) && (!balanceComparison || !genericComparisonIntro.test(intro.trim()));
  return <>
    {question ? <p className="clarification">{question}</p> : showIntro && <StreamingRichText text={intro} live={liveReply} className="experience-intro" />}
    {partial && <p className="partial-result">Some matching content is unavailable.</p>}
  </>;
}

function SurfaceFollowUps({ children }: { children: ReactNode[] }) {
  const { balanceComparison } = useContext(SurfaceActions);
  const actions = children.length > 0 && <div className="follow-up-list">{children}</div>;
  return balanceComparison ? <details className="balance-comparison-help">
    <summary>Why do they differ? <ChevronDown size={15} aria-hidden="true" /></summary>
    <p>Activity can change what’s available to use before it’s reflected in the recorded total.</p>
    {actions}
  </details> : actions;
}

const SurfaceActions = createContext({
  enabled: false, preview: false, pendingPortfolio: false, experienceId: "",
  completedFunding: undefined as { confirmedAt?: number } | undefined,
  balanceComparison: false, hiddenActionComponents: [] as string[],
});
const pznCatalog = new Catalog<ReactCatalogComponent>(PZN_CATALOG_ID, "1.0", [
  createComponentImplementation(experienceRoot, ({ props, buildChild }) => {
    const { preview, hiddenActionComponents } = useContext(SurfaceActions);
    const children = Array.isArray(props.children) ? props.children.map((child) => (
      typeof child === "string" ? { id: child, basePath: undefined } : child
    )) : [];
    const count = children.length - props.actionCount;
    const content = children.slice(0, count);
    const followUps = children.slice(count).filter(({ id }) => !hiddenActionComponents.includes(id));
    return (
      <div className={surfaceClass({ ...props, preview })} data-renderer="a2ui">
        <Introduction intro={props.intro} question={props.question} partial={props.partial} />
        {content.map(({ id, basePath }) => <div className="surface-child" key={id}>{buildChild(id, basePath)}</div>)}
        <SurfaceFollowUps>{followUps.map(({ id, basePath }) => <div key={id}>{buildChild(id, basePath)}</div>)}</SurfaceFollowUps>
      </div>
    );
  }),
  createComponentImplementation(contentCard, ({ props }) => <ContentBlock block={{ component: contentCard.name, props }} />),
  createComponentImplementation(comparison, ({ props }) => <ContentBlock block={{ component: comparison.name, props }} />),
  createComponentImplementation(stepList, ({ props }) => <ContentBlock block={{ component: stepList.name, props }} />),
  createComponentImplementation(metricSummary, ({ props }) => <ContentBlock block={{ component: metricSummary.name, props }} />),
  createComponentImplementation(retirementAccounts, ({ props }) => <RetirementAccountsCard {...props} />),
  createComponentImplementation(goalProgressCard, ({ props, context }) => {
    const { enabled } = useContext(SurfaceActions);
    return <ContentBlock block={{ component: goalProgressCard.name, props }} onAction={enabled
      ? (actionId) => void context.dispatchAction({ event: { name: FOLLOW_UP_EVENT, context: { actionId } } }).catch(() => undefined)
      : undefined} />;
  }),
  createComponentImplementation(portfolioSnapshot, ({ props }) => <ChatPortfolio {...props} />),
  createComponentImplementation(fundingPreview, ({ props }) => <FundingPreviewBlock {...props} />),
  createComponentImplementation(fundingOptions, ({ props }) => <FundingOptionsBlock {...props} />),
  createComponentImplementation(ruleCreation, ({ props }) => <RuleBlock {...props} />),
  createComponentImplementation(layoutText, ({ props }) => <LayoutText {...props} />),
  createComponentImplementation(customForm, ({ props }) => <CustomFormBlock {...props} />),
  createComponentImplementation(boundWidget, ({ props }) => <BoundWidgetBlock {...props} />),
  createComponentImplementation(widgetWizard, ({ props }) => <WidgetWizardBlock {...props} />),
  createComponentImplementation(dynamicCanvas, ({ props, context }) => {
    const controls = useContext(ExperienceControls);
    const { enabled } = useContext(SurfaceActions);
    return <DynamicCanvasBlock {...props} onFollowUp={controls.askPrompt} onAction={enabled
      ? (actionId) => void context.dispatchAction({ event: { name: FOLLOW_UP_EVENT, context: { actionId } } }).catch(() => undefined)
      : undefined} />;
  }),
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
  return <span>{renderInlineMarkdown(markdown)}</span>;
}

export function MountedSurface({ input, id, onAction, basic, onRendered }: {
  input: unknown;
  id: string;
  onAction: (action: ActionMessage) => void;
  basic?: boolean;
  onRendered?: () => void;
}) {
  const [applied, setApplied] = useState<{ surface: SurfaceModel<ReactCatalogComponent>; input: unknown }>();
  const binding = useRef<{ processor: MessageProcessor<ReactCatalogComponent>; previous?: CreateSurfaceMessage }>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const callbacks = useRef({ onAction, onRendered });
  callbacks.current = { onAction, onRendered };
  // Attach the verified surface before the browser paints the finished message.
  useLayoutEffect(() => {
    const processor = new MessageProcessor<ReactCatalogComponent>(
      basic ? [basicCatalog] : [pznCatalog],
      (action) => { callbacks.current.onAction(ActionMessageSchema.parse({ version: "1.0", action })); },
    );
    binding.current = { processor };
    return () => {
      binding.current = undefined;
      try { if (processor.getSurface(id)) processor.processMessages([{ version: "1.0", deleteSurface: { surfaceId: id } }]); }
      finally { processor.dispose(); }
    };
  }, [id, basic]);
  useLayoutEffect(() => {
    const state = binding.current!;
    const { processor, previous } = state;
    try {
      const message = basic ? CreateSurfaceMessageSchema.parse(input) : validatePznSurface(input, id);
      const next = message.createSurface;
      const extendsPrevious = !basic && previous?.createSurface.components?.every((old) =>
        next.components?.some((node) => node.id === old.id && node.component === old.component));
      if (previous && extendsPrevious && next.components) {
        // Update the existing nodes so a customer can keep a slider or disclosure open.
        const byId = new Map(previous.createSurface.components?.map((node) => [node.id, node]));
        const changes = next.components.filter((node) => JSON.stringify(node) !== JSON.stringify(byId.get(node.id)));
        if (changes.length) processor.processMessages([{ version: "1.0", updateComponents: { surfaceId: id, components: changes } }]);
        if (previous.createSurface.dataModel?.intro !== next.dataModel?.intro) {
          processor.processMessages([{ version: "1.0", updateDataModel: { surfaceId: id, path: "/intro", value: next.dataModel?.intro } }]);
        }
      } else {
        if (previous) processor.processMessages([{ version: "1.0", deleteSurface: { surfaceId: id } }]);
        processor.processMessages([message]);
      }
      const created = processor.getSurface(id);
      if (!created) throw new Error("A2UI surface is missing");
      state.previous = message;
      setApplied({ surface: created, input });
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("A2UI surface failed"));
    }
  }, [id, input, basic]);

  useEffect(() => {
    if (applied && applied.input === input) callbacks.current.onRendered?.();
  }, [applied, input]);
  if (error) throw error;
  return applied ? <MarkdownComponentContext.Provider value={PlainText}><A2uiSurface surface={applied.surface} /></MarkdownComponentContext.Provider> : null;
}

class SurfaceBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { fallback: boolean }> {
  state = { fallback: false };
  static getDerivedStateFromError() { return { fallback: true }; }
  render() { return this.state.fallback ? this.props.fallback : this.props.children; }
}
type SurfaceControls = {
  accountFunding?: {
    conversationId: string;
    latestExperienceId?: string;
    canResume: boolean;
    completion?: { confirmedAt?: number };
  };
  activeExperienceId?: string;
  goalScenarios?: ReadonlyMap<string, GoalSavingsProjection>;
  allowRuleCreation?: boolean;
  simplifyBalanceComparison?: boolean;
  askPrompt?: (prompt: string) => void;
  onWriteBack?: (updates: Record<string, string>) => Promise<string[]>;
  followUp: (id: string, envelope: ActionMessage) => void;
  rendered: (id: string, fallback?: boolean, previewTurnId?: string) => void;
};
export const ExperienceControls = createContext<SurfaceControls>({
  followUp: () => undefined, rendered: () => undefined,
});

type ChatSurface = DisplayExperience & { previewTurnId?: string };
function CanonicalFallback({ experience, enabled }: { experience: ChatSurface; enabled: boolean }) {
  const controls = useContext(ExperienceControls);
  const { experienceId } = experience;
  const { preview, hiddenActionComponents } = useContext(SurfaceActions);
  const rendered = useRef(controls.rendered);
  rendered.current = controls.rendered;
  useEffect(() => rendered.current(experienceId, true, experience.previewTurnId), [experienceId, experience.previewTurnId]);
  return <div className={surfaceClass({ ...experience, preview })} data-renderer="fallback">
    <Introduction intro={experience.intro} question={experience.question} partial={experience.partial} />
    {experience.blocks.map((block, index) => <div className="surface-child" key={index}>
      <ContentBlock block={block} form={{ experienceId, componentId: "block_" + (index + 1), enabled }} />
    </div>)}
    <SurfaceFollowUps>
      {experience.actions.filter(({ componentId }) => !hiddenActionComponents.includes(componentId)).map(({ actionId, componentId, label }) => (
        <button key={actionId} type="button" className="follow-up" disabled={!enabled} onClick={() => (
          controls.followUp(experienceId, {
            version: "1.0", action: {
              name: FOLLOW_UP_EVENT, surfaceId: experienceId, sourceComponentId: componentId,
              timestamp: new Date().toISOString(), context: { actionId },
            },
          })
        )}>{label}</button>
      ))}
    </SurfaceFollowUps>
  </div>;
}

function ExperiencePart({ data, preview = false }: { data: ChatSurface; preview?: boolean }) {
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
  const completedFunding = !preview && controls.accountFunding?.latestExperienceId === experienceId
    ? controls.accountFunding.completion : undefined;
  const [block] = data.blocks;
  const balanceComparison = Boolean(controls.simplifyBalanceComparison && !preview && !data.layout && !data.theme
    && data.blocks.length === 1 && block?.component === comparison.name
    && ["fixture:balance_available_definition", "fixture:balance_current_definition"]
      .every((ref) => block.props.sources.some((source) => source.ref === ref)));
  const hiddenActionComponents = balanceComparison
    ? data.actions.filter(({ label }) => label === "Compare balance terms").map(({ componentId }) => componentId)
    : [];
  return <SurfaceActions.Provider value={{ enabled, preview, experienceId, completedFunding, pendingPortfolio: Boolean(data.previewTurnId), balanceComparison, hiddenActionComponents }}>
    <LiveSimulationProvider>
      <SurfaceBoundary key={experienceId} fallback={<CanonicalFallback experience={data} enabled={enabled} />}>
        <MountedSurface id={experienceId} input={messages[0]}
          onAction={(envelope) => controls.followUp(experienceId, envelope)}
          onRendered={() => controls.rendered(experienceId, false, data.previewTurnId)} />
      </SurfaceBoundary>
    </LiveSimulationProvider>
  </SurfaceActions.Provider>;
}
export function ExperienceLayoutPreview({ data }: { data: DisplayExperience }) {
  return <ExperiencePart data={data} preview />;
}

export function ExperienceCanvasView({ data }: { data: DisplayExperience }) {
  return <ExperiencePart data={data} />;
}

export const ExperienceDataUI = makeAssistantDataUI<DisplayExperience>({ name: "experience-surface", render: ExperiencePart });
