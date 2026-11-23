import { useId } from "react";
import { formatPortfolioAmount, type PortfolioSnapshot } from "../../packages/contracts/portfolio";

const asOfFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

export function PortfolioSnapshotBlock({ asOf, cashCents, equityCents, fixedIncomeCents }: PortfolioSnapshot) {
  const title = useId();
  const invested = equityCents + fixedIncomeCents;
  const total = cashCents + invested;
  const allocation = [
    { label: "Stocks", amount: equityCents, color: "equities" },
    { label: "Fixed income", amount: fixedIncomeCents, color: "fixed-income" },
    { label: "Cash", amount: cashCents, color: "cash" },
  ];
  const percent = (amount: number) => (total ? amount / total * 100 : 0);
  return <section className="content-card portfolio-snapshot" aria-labelledby={title}>
    <header className="portfolio-heading">
      <h3 id={title}>Portfolio snapshot</h3>
      <p>As of <time dateTime={asOf}>{asOfFormat.format(new Date(asOf))}</time></p>
    </header>
    <dl className="portfolio-values">
      <div><dt>Total value</dt><dd>{formatPortfolioAmount(total)}</dd></div>
      <div><dt>Invested</dt><dd>{formatPortfolioAmount(invested)}</dd></div>
      <div><dt>Cash</dt><dd>{formatPortfolioAmount(cashCents)}</dd></div>
    </dl>
    <h4>Portfolio breakdown</h4>
    <div className="portfolio-allocation-bar" aria-hidden="true">
      {allocation.map(({ amount, color }) => <span className={color} key={color} style={{ width: percent(amount) + "%" }} />)}
    </div>
    <ul className="portfolio-allocation">
      {allocation.map(({ label, amount, color }) => <li key={color}>
        <span className={color} aria-hidden="true" />{label} <strong>{Number(percent(amount).toFixed(1))}%</strong>
      </li>)}
    </ul>
  </section>;
}
