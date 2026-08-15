import type { SeriesPoint } from "./types";

export type CashBufferPoint = {
  date: string;
  totalValue: number;
  investedValue: number;
  cashPool: number;
  invested: number;
};

export type CashDeployEvent = {
  date: string;
  triggerLevel: number; // negative fraction, e.g. -0.15
  drawdown: number; // negative fraction, actual drawdown at trigger time
  deployAmount: number;
  cashPoolAfter: number;
};

export type CashBufferResult = { points: CashBufferPoint[]; events: CashDeployEvent[] };

// Tactical "buy the dip" variant of DCA: each month, only `1 - cashRatio` of
// the contribution is invested immediately — the rest sits in an idle cash
// pool. Whenever the underlying (weighted) market index makes a new all-time
// high, every trigger level is re-armed. As the index falls through each
// trigger level (sorted shallowest first), that fraction of the remaining
// cash pool gets deployed at the current price, so the pool empties out
// gradually across the defined levels rather than all at once. Each deploy
// is recorded as a CashDeployEvent.
export function simulateCashBuffer(
  tickerSeries: { ticker: string; data: SeriesPoint[] }[],
  weights: Record<string, number>,
  options: {
    monthlyAmount?: number;
    cashRatio?: number;
    triggerLevels?: number[]; // negative fractions, e.g. [-0.15, -0.25]
  } = {},
): CashBufferResult {
  if (tickerSeries.length === 0) return { points: [], events: [] };

  const monthlyAmount = options.monthlyAmount ?? 100;
  const cashRatio = Math.min(1, Math.max(0, options.cashRatio ?? 0.2));
  const triggerLevels = [...(options.triggerLevels ?? [-0.15, -0.25])].sort((a, b) => b - a);

  const totalWeight = tickerSeries.reduce((sum, t) => sum + (weights[t.ticker] ?? 0), 0);
  if (totalWeight <= 0) return { points: [], events: [] };
  const normalizedWeights = tickerSeries.map((t) => (weights[t.ticker] ?? 0) / totalWeight);

  const dates = tickerSeries[0].data.map((d) => d.date);
  const prices = tickerSeries.map((t) => t.data.map((d) => d.value));
  const n = dates.length;

  const marketIndex = dates.map((_, i) => {
    let v = 0;
    for (let j = 0; j < tickerSeries.length; j++) v += prices[j][i] * normalizedWeights[j];
    return v;
  });

  const shares = new Array(tickerSeries.length).fill(0);
  const fired = new Array(triggerLevels.length).fill(false);
  let cashPool = 0;
  let invested = 0;
  let lastMonthKey = "";
  let runningMax = marketIndex[0];

  function invest(amount: number, i: number) {
    for (let j = 0; j < tickerSeries.length; j++) {
      const price = prices[j][i];
      if (price > 0) shares[j] += (normalizedWeights[j] * amount) / price;
    }
  }

  const points: CashBufferPoint[] = [];
  const events: CashDeployEvent[] = [];

  for (let i = 0; i < n; i++) {
    const date = dates[i];
    const monthKey = date.slice(0, 7);

    if (monthKey !== lastMonthKey) {
      lastMonthKey = monthKey;
      invested += monthlyAmount;
      invest(monthlyAmount * (1 - cashRatio), i);
      cashPool += monthlyAmount * cashRatio;
    }

    if (marketIndex[i] > runningMax) {
      runningMax = marketIndex[i];
      fired.fill(false);
    }

    const drawdown = runningMax > 0 ? (marketIndex[i] - runningMax) / runningMax : 0;

    for (let k = 0; k < triggerLevels.length; k++) {
      if (!fired[k] && drawdown <= triggerLevels[k]) {
        fired[k] = true;
        const remaining = triggerLevels.length - k;
        const deployAmount = cashPool / remaining;
        invest(deployAmount, i);
        cashPool -= deployAmount;
        events.push({
          date,
          triggerLevel: triggerLevels[k],
          drawdown,
          deployAmount: Math.round(deployAmount),
          cashPoolAfter: Math.round(cashPool),
        });
      }
    }

    let investedValue = 0;
    for (let j = 0; j < tickerSeries.length; j++) investedValue += shares[j] * prices[j][i];

    points.push({
      date,
      investedValue: Math.round(investedValue),
      cashPool: Math.round(cashPool),
      totalValue: Math.round(investedValue + cashPool),
      invested,
    });
  }

  return { points, events };
}
