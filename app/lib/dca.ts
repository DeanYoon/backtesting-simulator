import type { SeriesPoint } from "./types";
import { computeAnnualizedVolatility } from "./metrics";

export type DCAPoint = { date: string; value: number; invested: number };

export type RebalanceEvent = {
  date: string;
  // percentages (0-100), one per ticker in the same order as `tickerSeries`
  beforeRatio: number[];
  afterRatio: number[];
};

export type DCAResult = { points: DCAPoint[]; events: RebalanceEvent[] };

// Percentage-point band around each ticker's target weight before a
// threshold rebalance fires — e.g. a 20% target only triggers once the
// actual weight reaches 10% or 30% (a full 10-point move away from target),
// not merely a rounding-boundary 5 points away.
const DRIFT_THRESHOLD_PCT = 10;

// Volatility-scaled band is clamped to [0.5x, 2x] the base threshold, so a
// very calm or very wild ticker still gets a sane (not degenerate) band.
const MIN_VOLATILITY_MULTIPLIER = 0.5;
const MAX_VOLATILITY_MULTIPLIER = 2;

// Scales each ticker's drift threshold by its own annualized volatility
// relative to the group average - a more volatile ticker naturally drifts
// further from its target on noise alone, so it gets a WIDER band (avoiding
// pointless frequent rebalancing); a calmer ticker gets a NARROWER band so
// genuine long-term drift still gets caught instead of being masked by a
// band sized for its more volatile portfolio-mates.
export function computeVolatilityThresholds(
  tickerSeries: { ticker: string; data: SeriesPoint[] }[],
  baseThresholdPct: number = DRIFT_THRESHOLD_PCT,
): number[] {
  const volatilities = tickerSeries.map((t) => computeAnnualizedVolatility(t.data) ?? 0);
  const validVols = volatilities.filter((v) => v > 0);
  if (validVols.length === 0) return tickerSeries.map(() => baseThresholdPct);
  const avgVol = validVols.reduce((sum, v) => sum + v, 0) / validVols.length;
  return volatilities.map((v) => {
    if (avgVol <= 0 || v <= 0) return baseThresholdPct;
    const multiplier = Math.min(
      MAX_VOLATILITY_MULTIPLIER,
      Math.max(MIN_VOLATILITY_MULTIPLIER, v / avgVol),
    );
    return baseThresholdPct * multiplier;
  });
}

// Simulates monthly dollar-cost-averaging into a set of tickers at fixed
// target weights: on the first trading day seen in each new calendar month,
// a fixed contribution is split by weight and converted to "shares" at that
// day's price.
//
// rebalanceMode "threshold": every day, each ticker's actual holding weight
// (in %) is compared against its target weight. The moment any ticker has
// drifted DRIFT_THRESHOLD_PCT percentage points or more away from its
// target (e.g. a 10:90 target drifting to 20:80, or 40:60 drifting to
// 50:50), the whole position is sold and rebought at the target weights —
// and that moment is recorded as a RebalanceEvent.
//
// rebalanceMode "volatility": same trigger logic, but each ticker gets its
// own band (see `computeVolatilityThresholds`) instead of a flat 10pt for
// everyone.
export function simulateDCA(
  tickerSeries: { ticker: string; data: SeriesPoint[] }[],
  weights: Record<string, number>,
  options: { monthlyAmount?: number; rebalanceMode?: "none" | "threshold" | "volatility" } = {},
): DCAResult {
  if (tickerSeries.length === 0) return { points: [], events: [] };

  const monthlyAmount = options.monthlyAmount ?? 100;
  const rebalanceMode = options.rebalanceMode ?? "none";

  const totalWeight = tickerSeries.reduce((sum, t) => sum + (weights[t.ticker] ?? 0), 0);
  if (totalWeight <= 0) return { points: [], events: [] };
  const normalizedWeights = tickerSeries.map((t) => (weights[t.ticker] ?? 0) / totalWeight);
  const targetPct = normalizedWeights.map((w) => w * 100);

  const thresholds =
    rebalanceMode === "volatility"
      ? computeVolatilityThresholds(tickerSeries)
      : tickerSeries.map(() => DRIFT_THRESHOLD_PCT);

  const dates = tickerSeries[0].data.map((d) => d.date);
  const prices = tickerSeries.map((t) => t.data.map((d) => d.value));
  const n = dates.length;

  const shares = new Array(tickerSeries.length).fill(0);
  const points: DCAPoint[] = [];
  const events: RebalanceEvent[] = [];
  let invested = 0;
  let lastMonthKey = "";

  for (let i = 0; i < n; i++) {
    const date = dates[i];
    const monthKey = date.slice(0, 7);

    if (monthKey !== lastMonthKey) {
      lastMonthKey = monthKey;
      invested += monthlyAmount;
      for (let j = 0; j < tickerSeries.length; j++) {
        const price = prices[j][i];
        if (price > 0) shares[j] += (normalizedWeights[j] * monthlyAmount) / price;
      }
    }

    if (rebalanceMode === "threshold" || rebalanceMode === "volatility") {
      let totalValue = 0;
      for (let j = 0; j < tickerSeries.length; j++) totalValue += shares[j] * prices[j][i];

      if (totalValue > 0) {
        const currentPct = shares.map((sh, j) => ((sh * prices[j][i]) / totalValue) * 100);
        const drifted = currentPct.some(
          (pct, j) => Math.abs(pct - targetPct[j]) >= thresholds[j] - 1e-9,
        );

        if (drifted) {
          events.push({
            date,
            beforeRatio: currentPct.map((pct) => Math.round(pct * 10) / 10),
            afterRatio: targetPct.map((pct) => Math.round(pct * 10) / 10),
          });
          for (let j = 0; j < tickerSeries.length; j++) {
            const price = prices[j][i];
            if (price > 0) shares[j] = (normalizedWeights[j] * totalValue) / price;
          }
        }
      }
    }

    let value = 0;
    for (let j = 0; j < tickerSeries.length; j++) value += shares[j] * prices[j][i];
    points.push({ date, value: Math.round(value), invested });
  }

  return { points, events };
}
