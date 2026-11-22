import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import type { GoalProgress } from "../../packages/contracts/goal-progress";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import "./goal-progress.css";

const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthFull = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
});

function monthDate(month: string) {
  return new Date(month + "-01T00:00:00Z");
}

function monthIndex(month: string) {
  const [year, number] = month.split("-").map(Number);
  return year * 12 + number - 1;
}

function drawSavings(canvas: HTMLCanvasElement, { history, targetCents }: Pick<GoalProgress, "history" | "targetCents">) {
  const { clientWidth: width, clientHeight: height } = canvas;
  const context = canvas.getContext("2d");
  if (width < 100 || height < 60 || !context) return;
  const density = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * density);
  canvas.height = Math.round(height * density);
  context.setTransform(density, 0, 0, density, 0, 0);

  const left = 57;
  const right = width - 23;
  const top = 15;
  const bottom = height - 32;
  const limit = Math.max(targetCents, ...history.map(({ savedCents }) => savedCents));
  const start = monthIndex(history[0].month);
  const end = monthIndex(history[history.length - 1].month);
  const yFor = (cents: number) => bottom - (cents / limit) * (bottom - top);
  const points = history.map(({ month, savedCents }) => ({
    month,
    x: left + (monthIndex(month) - start) / (end - start) * (right - left),
    y: yFor(savedCents),
  }));

  context.font = "11px Inter Variable, system-ui, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.lineWidth = 1;
  for (const amount of [0, limit / 2, limit]) {
    const y = yFor(amount);
    context.strokeStyle = "#dee8df";
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    context.fillStyle = "#4d6558";
    context.fillText(compactUsd.format(amount / 100), left - 9, y);
  }

  const tracePoints = () => {
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  };
  context.beginPath();
  tracePoints();
  context.lineTo(right, bottom);
  context.lineTo(left, bottom);
  context.closePath();
  const area = context.createLinearGradient(0, top, 0, bottom);
  area.addColorStop(0, "#8ebf9aaa");
  area.addColorStop(1, "#cfe4d545");
  context.fillStyle = area;
  context.fill();

  context.setLineDash([5, 5]);
  context.strokeStyle = "#8b6947";
  context.beginPath();
  context.moveTo(left, yFor(targetCents));
  context.lineTo(right, yFor(targetCents));
  context.stroke();
  context.setLineDash([]);

  context.strokeStyle = "#226149";
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  context.beginPath();
  tracePoints();
  context.stroke();

  context.textAlign = "center";
  let lastLabelX = -Infinity;
  const labelSpacing = 37;
  for (const [index, point] of points.entries()) {
    const last = index === points.length - 1;
    context.beginPath();
    context.arc(point.x, point.y, last ? 4.5 : 3.4, 0, Math.PI * 2);
    context.fillStyle = "#226149";
    context.fill();
    if (last || (point.x - lastLabelX >= labelSpacing && right - point.x >= labelSpacing)) {
      context.fillStyle = "#4d6558";
      context.fillText(monthShort.format(monthDate(point.month)), point.x, bottom + 18);
      lastLabelX = point.x;
    }
  }
}

export function GoalProgressDetails({ goal }: { goal: GoalProgress }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { history, targetCents } = goal;
  const first = history[0];
  const latest = history[history.length - 1];
  const saved = latest.savedCents;
  const remaining = Math.max(0, targetCents - saved);
  const percent = Math.min(100, Math.floor(saved * 100 / targetCents));
  const change = saved - first.savedCents;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const paint = () => drawSavings(element, goal);
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    paint();
    return () => observer.disconnect();
  }, [goal]);

  return <div className="goal-progress-details">
    <div className="goal-progress-layout">
      <div className="goal-summary">
        <dl className="goal-values">
          <div><dt>Saved</dt><dd>{formatPortfolioAmount(saved)}</dd></div>
          <div><dt>Target</dt><dd>{formatPortfolioAmount(targetCents)}</dd></div>
          <div><dt>Remaining</dt><dd>{formatPortfolioAmount(remaining)}</dd></div>
        </dl>
        <div className="goal-meter">
          <progress aria-label="Down payment progress" max={targetCents} value={Math.min(saved, targetCents)} />
          <strong>{percent}% saved</strong>
        </div>
      </div>
      <figure className="goal-figure">
        <figcaption className="goal-chart-heading">
          <div>
            <h4>Savings growth</h4>
            <p>{monthFull.format(monthDate(first.month))} to {monthFull.format(monthDate(latest.month))}</p>
          </div>
          <strong className="goal-change">{change > 0 ? "+" : ""}{formatPortfolioAmount(change)}</strong>
        </figcaption>
        <canvas
          ref={canvas}
          role="img"
          aria-label={`Down payment savings from ${formatPortfolioAmount(first.savedCents)} to ${formatPortfolioAmount(saved)} toward a ${formatPortfolioAmount(targetCents)} target.`}
        />
        <div className="goal-legend" aria-hidden="true"><span>Saved</span><span>Target</span></div>
      </figure>
    </div>
    <details className="inline-details goal-history">
      <summary>View monthly values <ChevronDown size={14} aria-hidden="true" /></summary>
      <table>
        <thead><tr><th scope="col">Month</th><th scope="col">Saved</th></tr></thead>
        <tbody>{history.map(({ month, savedCents }) => (
          <tr key={month}><th scope="row"><time dateTime={month}>{monthFull.format(monthDate(month))}</time></th><td>{formatPortfolioAmount(savedCents)}</td></tr>
        ))}</tbody>
      </table>
    </details>
  </div>;
}
