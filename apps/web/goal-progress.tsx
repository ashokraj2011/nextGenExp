import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { formatGoalMonth, goalMonthIndex, type GoalProgress, type GoalSavingsProjection } from "../../packages/contracts/goal-progress";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import "./goal-progress.css";

const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
});

function monthDate(month: string) {
  return new Date(month + "-01T00:00:00Z");
}

function drawSavings(canvas: HTMLCanvasElement, { history, targetCents }: GoalProgress, projection?: GoalSavingsProjection) {
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
  const limit = Math.max(targetCents, ...history.map(({ savedCents }) => savedCents),
    ...(projection?.points.map(({ projectedCents }) => projectedCents) ?? []));
  const start = goalMonthIndex(history[0].month);
  const end = goalMonthIndex(projection?.points.at(-1)?.month ?? history.at(-1)!.month);
  const xFor = (month: string) => left + (goalMonthIndex(month) - start) / (end - start) * (right - left);
  const yFor = (cents: number) => bottom - (cents / limit) * (bottom - top);
  const points = history.map(({ month, savedCents }) => ({ month, x: xFor(month), y: yFor(savedCents) }));

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

  const tracePoints = (line: { x: number; y: number }[]) => {
    context.moveTo(line[0].x, line[0].y);
    for (const point of line.slice(1)) context.lineTo(point.x, point.y);
  };
  context.beginPath();
  tracePoints(points);
  context.lineTo(points.at(-1)!.x, bottom);
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

  context.strokeStyle = "#368727";
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  context.beginPath();
  tracePoints(points);
  context.stroke();

  for (const [index, point] of points.entries()) {
    const last = index === points.length - 1;
    context.beginPath();
    context.arc(point.x, point.y, last ? 4.5 : 3.4, 0, Math.PI * 2);
    context.fillStyle = "#368727";
    context.fill();
  }

  if (projection) {
    const drawProjection = (field: "currentCents" | "projectedCents", color: string, dash: number[]) => {
      context.setLineDash(dash);
      context.strokeStyle = color;
      context.beginPath();
      tracePoints(projection.points.map((point) => ({ x: xFor(point.month), y: yFor(point[field]) })));
      context.stroke();
    };
    drawProjection("currentCents", "#5b6d62", [2, 4]);
    drawProjection("projectedCents", "#2a5b9d", [7, 4]);
    context.setLineDash([]);
  }

  context.textAlign = "center";
  let lastLabelX = -Infinity;
  const labelSpacing = 37;
  const monthLabels = [...history.map(({ month }) => month), ...(projection?.points.slice(1).map(({ month }) => month) ?? [])];
  for (const [index, month] of monthLabels.entries()) {
    const x = xFor(month);
    const last = index === monthLabels.length - 1;
    if (last || (x - lastLabelX >= labelSpacing && right - x >= labelSpacing)) {
      context.fillStyle = "#4d6558";
      context.fillText(monthShort.format(monthDate(month)), x, bottom + 18);
      lastLabelX = x;
    }
  }
}

export function SavingsGrowthChart({ goal, projection }: { goal: GoalProgress; projection?: GoalSavingsProjection }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { history, targetCents } = goal;
  const first = history[0];
  const latest = history[history.length - 1];
  const saved = latest.savedCents;
  const change = saved - first.savedCents;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const paint = () => drawSavings(element, goal, projection);
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    paint();
    return () => observer.disconnect();
  }, [goal, projection]);

  return <figure className="goal-figure">
    <figcaption className="goal-chart-heading">
      <div>
        <h4>Savings growth</h4>
        <p>{formatGoalMonth(first.month)} to {formatGoalMonth(projection?.points.at(-1)?.month ?? latest.month)}</p>
      </div>
      <strong className="goal-change">{change > 0 ? "+" : ""}{formatPortfolioAmount(change)}</strong>
    </figcaption>
    <canvas
      ref={canvas}
      role="img"
      aria-label={projection
        ? `Savings with an extra ${formatPortfolioAmount(projection.extraMonthlyCents)} a month starting ${formatGoalMonth(projection.startMonth)}. Projected target ${projection.projectedTargetMonth ? formatGoalMonth(projection.projectedTargetMonth) : "beyond 10 years"}.`
        : `Down payment savings from ${formatPortfolioAmount(first.savedCents)} to ${formatPortfolioAmount(saved)} toward a ${formatPortfolioAmount(targetCents)} target.`}
    />
    <div className="goal-legend" aria-hidden="true">
      <span>Saved</span>
      {projection && <><span className="goal-legend-current">Current plan</span><span className="goal-legend-project">With extra savings</span></>}
      <span className="goal-legend-target">Target</span>
    </div>
  </figure>;
}

export function GoalProgressDetails({ goal, projection, extraMonthlyCents, onPreview }: {
  goal: GoalProgress;
  projection?: GoalSavingsProjection;
  extraMonthlyCents?: number;
  onPreview?: () => void;
}) {
  const { history, targetCents } = goal;
  const saved = history[history.length - 1].savedCents;
  const remaining = Math.max(0, targetCents - saved);
  const percent = Math.min(100, Math.floor(saved * 100 / targetCents));

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
      <SavingsGrowthChart goal={goal} projection={projection} />
    </div>
    {projection ? (
      <div className="goal-scenario" aria-label="Savings scenario">
        <dl>
          <div><dt>Current plan · {formatPortfolioAmount(projection.currentMonthlyCents)}/mo</dt>
            <dd>{projection.currentTargetMonth ? formatGoalMonth(projection.currentTargetMonth) : "Beyond 10 years"}</dd></div>
          <div><dt>With an extra {formatPortfolioAmount(projection.extraMonthlyCents)}/mo</dt>
            <dd>{projection.projectedTargetMonth ? formatGoalMonth(projection.projectedTargetMonth) : "Beyond 10 years"}</dd></div>
        </dl>
        <p>Extra savings start <strong>{formatGoalMonth(projection.startMonth)}</strong>. Estimated from monthly contributions.</p>
      </div>
    ) : extraMonthlyCents !== undefined && (
      <div className="goal-scenario-action">
        <button type="button" className="secondary-button" onClick={onPreview} disabled={!onPreview}>
          Add {formatPortfolioAmount(extraMonthlyCents)} a month
        </button>
        <span>Preview a savings change</span>
      </div>
    )}
    <details className="inline-details goal-history">
      <summary>View monthly values <ChevronDown size={14} aria-hidden="true" /></summary>
      <table>
        <thead><tr><th scope="col">Month</th><th scope="col">Saved</th></tr></thead>
        <tbody>{history.map(({ month, savedCents }) => (
          <tr key={month}><th scope="row"><time dateTime={month}>{formatGoalMonth(month)}</time></th><td>{formatPortfolioAmount(savedCents)}</td></tr>
        ))}</tbody>
      </table>
    </details>
  </div>;
}
