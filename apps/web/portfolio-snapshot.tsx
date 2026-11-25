import { useId, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { formatPortfolioAmount, type PortfolioSnapshot } from "../../packages/contracts/portfolio";

const asOfFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

export function PortfolioSnapshotBlock({ asOf, cashCents, equityCents, fixedIncomeCents, title = "Portfolio snapshot", footer, onExploreAllocation }:
  PortfolioSnapshot & { title?: string; footer?: ReactNode; onExploreAllocation?: (prompt: string) => void }) {
  const titleId = useId();
  const deployId = useId();
  const splitId = useId();
  const [simOpen, setSimOpen] = useState(false);
  const [deployDollars, setDeployDollars] = useState(() => Math.round((cashCents / 100) * 0.6 / 100) * 100);
  const [equitySplit, setEquitySplit] = useState(60);

  const invested = equityCents + fixedIncomeCents;
  const total = cashCents + invested;
  const maxCashDollars = Math.floor(cashCents / 100);

  const deployCents = Math.min(cashCents, Math.max(0, Math.round(deployDollars * 100)));
  const addedEquity = Math.round(deployCents * (equitySplit / 100));
  const addedFixed = deployCents - addedEquity;
  const simEquity = equityCents + addedEquity;
  const simFixed = fixedIncomeCents + addedFixed;
  const simCash = cashCents - deployCents;

  const allocation = [
    { label: "Stocks", amount: equityCents, simAmount: simEquity, color: "equities" },
    { label: "Fixed income", amount: fixedIncomeCents, simAmount: simFixed, color: "fixed-income" },
    { label: "Cash", amount: cashCents, simAmount: simCash, color: "cash" },
  ];
  const percent = (amount: number) => (total ? amount / total * 100 : 0);
  const activePct = (item: typeof allocation[number]) => percent(simOpen ? item.simAmount : item.amount);

  // Illustrative educational yield blend: Stocks ~1.8% div + growth, Fixed ~4.6%, Cash ~1.2%
  const baseYield = total > 0 ? ((equityCents * 0.018 + fixedIncomeCents * 0.046 + cashCents * 0.012) / total) * 100 : 0;
  const simYield = total > 0 ? ((simEquity * 0.018 + simFixed * 0.046 + simCash * 0.012) / total) * 100 : 0;
  const yieldDelta = simYield - baseYield;

  return <section className="content-card portfolio-snapshot" aria-labelledby={titleId}>
    <header className="portfolio-heading">
      <h3 id={titleId}>{title}</h3>
      <p>As of <time dateTime={asOf}>{asOfFormat.format(new Date(asOf))}</time></p>
    </header>
    <dl className="portfolio-values">
      <div><dt>Total value</dt><dd>{formatPortfolioAmount(total)}</dd></div>
      <div><dt>Invested</dt><dd>{formatPortfolioAmount(invested)}</dd></div>
      <div><dt>Cash</dt><dd>{formatPortfolioAmount(cashCents)}</dd></div>
    </dl>
    <h4>Portfolio breakdown</h4>
    <div className="portfolio-allocation-bar" aria-hidden="true">
      {allocation.map((item) => <span className={item.color} key={item.color} style={{ width: activePct(item) + "%" }} />)}
    </div>
    <ul className="portfolio-allocation">
      {allocation.map((item) => {
        const base = Number(percent(item.amount).toFixed(1));
        const next = Number(percent(item.simAmount).toFixed(1));
        const diff = Number((next - base).toFixed(1));
        return <li key={item.color}>
          <span className={item.color} aria-hidden="true" />{item.label} <strong>{simOpen ? next : base}%</strong>
          {simOpen && diff !== 0 && <em className={diff > 0 ? "alloc-delta-pos" : "alloc-delta-neg"}>({diff > 0 ? "+" : ""}{diff}%)</em>}
        </li>;
      })}
    </ul>

    {onExploreAllocation && maxCashDollars >= 500 && (
      <div className="portfolio-sim-wrap">
        <button type="button" className="portfolio-sim-toggle" aria-expanded={simOpen} onClick={() => setSimOpen((open) => !open)}>
          <SlidersHorizontal size={14} aria-hidden="true" />
          <span>Simulate cash deployment</span>
          {simOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>

        {simOpen && (
          <div className="portfolio-sim-panel">
            <div className="portfolio-sim-presets" role="group" aria-label="Allocation presets">
              <button type="button" onClick={() => { setDeployDollars(Math.round(maxCashDollars * 0.5 / 100) * 100); setEquitySplit(40); }}>Conservative (40/60)</button>
              <button type="button" onClick={() => { setDeployDollars(Math.round(maxCashDollars * 0.65 / 100) * 100); setEquitySplit(60); }}>Balanced (60/40)</button>
              <button type="button" onClick={() => { setDeployDollars(Math.round(maxCashDollars * 0.8 / 100) * 100); setEquitySplit(80); }}>Growth (80/20)</button>
            </div>
            <div className="portfolio-sim-sliders">
              <div className="axe-field">
                <div className="axe-field-head">
                  <label htmlFor={deployId}>Cash to deploy</label>
                  <output htmlFor={deployId}>{formatPortfolioAmount(deployCents)}</output>
                </div>
                <input id={deployId} type="range" min={0} max={maxCashDollars} step={100} value={deployDollars}
                  onChange={(e) => setDeployDollars(Number(e.target.value))} />
                <div className="axe-slider-bounds" aria-hidden="true"><span>$0</span><span>{formatPortfolioAmount(cashCents)}</span></div>
              </div>
              <div className="axe-field">
                <div className="axe-field-head">
                  <label htmlFor={splitId}>Stocks vs. Fixed income split</label>
                  <output htmlFor={splitId}>{equitySplit}% / {100 - equitySplit}%</output>
                </div>
                <input id={splitId} type="range" min={0} max={100} step={5} value={equitySplit}
                  onChange={(e) => setEquitySplit(Number(e.target.value))} />
                <div className="axe-slider-bounds" aria-hidden="true"><span>100% Fixed</span><span>100% Stocks</span></div>
              </div>
            </div>
            <div className="portfolio-sim-summary">
              <div>
                <span>Remaining cash</span>
                <strong>{formatPortfolioAmount(simCash)}</strong>
              </div>
              <div>
                <span>Illustrative yield</span>
                <strong>{simYield.toFixed(2)}% {yieldDelta !== 0 && <small>({yieldDelta > 0 ? "+" : ""}{yieldDelta.toFixed(2)}%)</small>}</strong>
              </div>
              <button type="button" className="axe-primary-button" disabled={deployCents === 0} onClick={() => {
                onExploreAllocation(
                  `I'd like to explore deploying ${formatPortfolioAmount(deployCents)} of my cash (${equitySplit}% into stocks and ${100 - equitySplit}% into fixed income), leaving ${formatPortfolioAmount(simCash)} in cash. What should I consider?`,
                );
              }}>
                Discuss this allocation <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </div>
    )}

    {footer && <div className="portfolio-footer">{footer}</div>}
  </section>;
}
