import type { SeriesPoint } from "./types";

const DAY_MS = 1000 * 60 * 60 * 24;
const YEAR_MS = DAY_MS * 365.25;
const DEFAULT_STEP_DAYS = 21; // ~1 month, matches the original app's rolling step

export type RollingCAGRPoint = {
  startDate: string;
  endDate: string;
  cagr: number;
  // Worst peak-to-trough decline that occurred *within this window only*
  // (fraction <= 0) — e.g. the specific 1-year holding period starting
  // 2020-01 might have seen a -34% drawdown even though other windows
  // didn't. This is per-window detail, not the whole-series MDD.
  maxDrawdown: number;
};

// Slides a fixed-length holding window across the whole series (start date
// advances ~1 month at a time) and computes the annualized return for each
// window: invest on day 1 and hold N years, invest ~1 month later and hold
// N years, and so on until the window would run past the last data point.
// This answers "if I'd held for N years, how did the outcome vary depending
// on when I started?" rather than a single trailing-return number.
export function computeRollingCAGR(
  data: SeriesPoint[],
  holdingYears: number,
  stepDays: number = DEFAULT_STEP_DAYS,
): RollingCAGRPoint[] {
  if (data.length < 2 || holdingYears <= 0) return [];

  const timestamps = data.map((d) => new Date(d.date).getTime());
  const n = timestamps.length;
  const holdMs = holdingYears * YEAR_MS;
  const stepMs = stepDays * DAY_MS;
  const lastTimestamp = timestamps[n - 1];

  const points: RollingCAGRPoint[] = [];
  let startIndex = 0;
  let endIndex = 0;
  let cursor = timestamps[0];

  while (cursor + holdMs <= lastTimestamp) {
    while (startIndex < n - 1 && timestamps[startIndex] < cursor) startIndex++;
    const targetEnd = timestamps[startIndex] + holdMs;
    if (endIndex < startIndex) endIndex = startIndex;
    while (endIndex < n - 1 && timestamps[endIndex] < targetEnd) endIndex++;

    const startValue = data[startIndex].value;
    const endValue = data[endIndex].value;
    const elapsedYears = (timestamps[endIndex] - timestamps[startIndex]) / YEAR_MS;

    if (startValue > 0 && elapsedYears > 0) {
      const cagr = Math.pow(endValue / startValue, 1 / elapsedYears) - 1;

      let peak = startValue;
      let maxDrawdown = 0;
      for (let i = startIndex; i <= endIndex; i++) {
        if (data[i].value > peak) peak = data[i].value;
        if (peak > 0) {
          const drawdown = (data[i].value - peak) / peak;
          if (drawdown < maxDrawdown) maxDrawdown = drawdown;
        }
      }

      points.push({
        startDate: data[startIndex].date,
        endDate: data[endIndex].date,
        cagr,
        maxDrawdown,
      });
    }

    cursor += stepMs;
  }

  return points;
}

export type RollingCAGRSummary = {
  total: number;
  positiveCount: number;
  negativeCount: number;
  avgCagr: number;
  minCagr: number;
  maxCagr: number;
  // Average, across all windows, of each window's own worst intra-window
  // drawdown (fraction <= 0) — not the whole-series MDD.
  avgMaxDrawdown: number;
};

export function summarizeRollingCAGR(points: RollingCAGRPoint[]): RollingCAGRSummary | null {
  if (points.length === 0) return null;
  const cagrs = points.map((p) => p.cagr);
  const positiveCount = cagrs.filter((c) => c > 0).length;
  const drawdowns = points.map((p) => p.maxDrawdown);
  return {
    total: points.length,
    positiveCount,
    negativeCount: points.length - positiveCount,
    avgCagr: cagrs.reduce((sum, c) => sum + c, 0) / cagrs.length,
    minCagr: Math.min(...cagrs),
    maxCagr: Math.max(...cagrs),
    avgMaxDrawdown: drawdowns.reduce((sum, d) => sum + d, 0) / drawdowns.length,
  };
}

// Largest peak-to-trough decline over the whole series, as a fraction <= 0
// (e.g. -0.35 for a 35% drawdown).
export function computeMaxDrawdown(data: SeriesPoint[]): number {
  if (data.length === 0) return 0;
  let peak = data[0].value;
  let maxDrawdown = 0;
  for (const point of data) {
    if (point.value > peak) peak = point.value;
    if (peak <= 0) continue;
    const drawdown = (point.value - peak) / peak;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

// Every non-negative integer weight combination (in `stepPercent` units)
// across `assetCount` assets that sums to 100% — e.g. 2 assets, 10% step:
// [0,100], [10,90], [20,80], ... [100,0]. Matches the C(n+k-1, k-1)
// stars-and-bars count from the original app (4 assets -> C(13,3) = 286).
export function generateWeightCombinations(
  assetCount: number,
  stepPercent = 10,
): number[][] {
  if (assetCount <= 0) return [];
  const steps = Math.round(100 / stepPercent);

  function recurse(remainingAssets: number, remainingSteps: number): number[][] {
    if (remainingAssets === 1) return [[remainingSteps * stepPercent]];
    const results: number[][] = [];
    for (let i = 0; i <= remainingSteps; i++) {
      for (const rest of recurse(remainingAssets - 1, remainingSteps - i)) {
        results.push([i * stepPercent, ...rest]);
      }
    }
    return results;
  }

  return recurse(assetCount, steps);
}

// Non-dominated (Pareto-optimal) points when maximizing both `returnValue`
// and `safety` — a point is dominated if some other point is at least as
// good on both axes and strictly better on at least one.
export function findParetoFrontier(
  points: { returnValue: number; safety: number }[],
): boolean[] {
  return points.map((a, i) =>
    !points.some((b, j) => {
      if (i === j) return false;
      const atLeastAsSafe = b.safety >= a.safety;
      const atLeastAsHighReturn = b.returnValue >= a.returnValue;
      const saferThan = b.safety > a.safety;
      const higherReturnThan = b.returnValue > a.returnValue;
      return (atLeastAsSafe && higherReturnThan) || (saferThan && atLeastAsHighReturn);
    }),
  );
}
