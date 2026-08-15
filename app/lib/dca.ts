import type { SeriesPoint } from "./types";

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
export function simulateDCA(
  tickerSeries: { ticker: string; data: SeriesPoint[] }[],
  weights: Record<string, number>,
  options: { monthlyAmount?: number; rebalanceMode?: "none" | "threshold" } = {},
): DCAResult {
  if (tickerSeries.length === 0) return { points: [], events: [] };

  const monthlyAmount = options.monthlyAmount ?? 100;
  const rebalanceMode = options.rebalanceMode ?? "none";

  const totalWeight = tickerSeries.reduce((sum, t) => sum + (weights[t.ticker] ?? 0), 0);
  if (totalWeight <= 0) return { points: [], events: [] };
  const normalizedWeights = tickerSeries.map((t) => (weights[t.ticker] ?? 0) / totalWeight);
  const targetPct = normalizedWeights.map((w) => w * 100);

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

    if (rebalanceMode === "threshold") {
      let totalValue = 0;
      for (let j = 0; j < tickerSeries.length; j++) totalValue += shares[j] * prices[j][i];

      if (totalValue > 0) {
        const currentPct = shares.map((sh, j) => ((sh * prices[j][i]) / totalValue) * 100);
        const drifted = currentPct.some(
          (pct, j) => Math.abs(pct - targetPct[j]) >= DRIFT_THRESHOLD_PCT - 1e-9,
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
