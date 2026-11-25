import { useEffect, useMemo, useRef, useState } from "react";
import { formatPortfolioAmount, type PortfolioHistoryPoint } from "../../packages/contracts/portfolio";

const ranges = [
  { id: "1m", label: "1 month", months: 1 },
  { id: "3m", label: "3 months", months: 3 },
  { id: "all", label: "All", months: 0 },
] as const;
type Range = typeof ranges[number];
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const compactAmount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const dateFor = (date: string) => new Date(date + "T00:00:00Z");

function historyFor(history: PortfolioHistoryPoint[], range: Range) {
  const latest = history.at(-1);
  if (!latest || range.months === 0) return history;
  const end = dateFor(latest.date);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - range.months, 1));
  const days = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(end.getUTCDate(), days));
  return history.filter(({ date }) => dateFor(date) >= start);
}

function drawHistory(canvas: HTMLCanvasElement, points: PortfolioHistoryPoint[]) {
  const { clientWidth: width, clientHeight: height } = canvas;
  const context = canvas.getContext("2d");
  if (width < 100 || height < 60 || points.length < 2 || !context) return;
  const density = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * density);
  canvas.height = Math.round(height * density);
  context.setTransform(density, 0, 0, density, 0, 0);
  const left = 54;
  const right = width - 22;
  const top = 14;
  const bottom = height - 30;
  const minimum = Math.min(...points.map(({ totalCents }) => totalCents));
  const maximum = Math.max(...points.map(({ totalCents }) => totalCents));
  const unit = 10 ** Math.floor(Math.log10(Math.max(100, maximum - minimum)));
  const lower = Math.floor(minimum / unit) * unit;
  const upper = Math.max(lower + unit, Math.ceil(maximum / unit) * unit);
  const firstTime = dateFor(points[0].date).getTime();
  const lastTime = dateFor(points[points.length - 1].date).getTime();
  const y = (cents: number) => bottom - (cents - lower) / (upper - lower) * (bottom - top);
  const plot = points.map(({ date, totalCents }) => ({
    date, x: left + (dateFor(date).getTime() - firstTime) / (lastTime - firstTime) * (right - left), y: y(totalCents),
  }));
  context.font = "11px Inter Variable, system-ui, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.strokeStyle = "#dce5ea";
  context.fillStyle = "#516376";
  for (const value of [lower, (lower + upper) / 2, upper]) {
    const line = y(value);
    context.beginPath();
    context.moveTo(left, line);
    context.lineTo(right, line);
    context.stroke();
    context.fillText(compactAmount.format(value / 100), left - 8, line);
  }
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  context.strokeStyle = "#368727";
  context.beginPath();
  context.moveTo(plot[0].x, plot[0].y);
  for (const point of plot.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
  context.textAlign = "center";
  let lastLabel = -Infinity;
  for (const [index, point] of plot.entries()) {
    const last = index === plot.length - 1;
    context.beginPath();
    context.arc(point.x, point.y, last ? 4 : 3, 0, Math.PI * 2);
    context.fillStyle = "#368727";
    context.fill();
    if (last || (point.x - lastLabel >= 51 && right - point.x >= 51)) {
      context.fillStyle = "#516376";
      context.fillText(shortDate.format(dateFor(point.date)), point.x, bottom + 18);
      lastLabel = point.x;
    }
  }
}

export function PortfolioHistory({ history }: { history: PortfolioHistoryPoint[] }) {
  const [range, setRange] = useState<Range>(ranges[2]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const points = useMemo(() => historyFor(history, range), [history, range]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const paint = () => drawHistory(element, points);
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    paint();
    return () => observer.disconnect();
  }, [points]);

  const start = points[0];
  const end = points.at(-1);
  return <section className="content-card portfolio-history" aria-label="Portfolio history">
    <header className="workspace-card-heading">
      <h3>Portfolio history</h3>
      {history.length >= 2 && <div className="history-ranges" role="group" aria-label="Portfolio date range">
        {ranges.map((option) => <button key={option.id} type="button" aria-pressed={range === option} onClick={() => setRange(option)}>{option.label}</button>)}
      </div>}
    </header>
    {start && end && points.length >= 2 ? <>
      <p className="portfolio-history-caption">{shortDate.format(dateFor(start.date))} to {shortDate.format(dateFor(end.date))}</p>
      <canvas ref={canvas} role="img" aria-label={`Portfolio value from ${formatPortfolioAmount(start.totalCents)} to ${formatPortfolioAmount(end.totalCents)}.`} />
      <details className="inline-details portfolio-history-values">
        <summary>View portfolio values</summary>
        <ul>{points.map(({ date, totalCents }) => <li key={date}><time dateTime={date}>{shortDate.format(dateFor(date))}</time><strong>{formatPortfolioAmount(totalCents)}</strong></li>)}</ul>
      </details>
    </> : <p className="portfolio-history-caption">There are fewer than two recorded values for this period.</p>}
  </section>;
}
