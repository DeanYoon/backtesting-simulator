import type { SeriesPoint } from "./types";

export type CashBufferPoint = {
  date: string;
  totalValue: number;
  investedValue: number;
  cashPool: number;
  invested: number;
};

export type CashRebalanceEvent = {
  date: string;
  // "cash": rebalances cash vs the stock sleeve as a whole. beforeRatio /
  // afterRatio are always [현금%, 주식%], summing to 100 on their own.
  // "stock": rebalances tickers against each other WITHIN the stock sleeve
  // only. beforeRatio / afterRatio are one entry per ticker, each ticker's
  // share of the stock sleeve (not of the whole pool), summing to 100 on
  // their own.
  // The two levels are checked and corrected independently so neither ever
  // has to blend cash and ticker weights into one combined (and often
  // non-round) percentage.
  level: "cash" | "stock";
  beforeRatio: number[];
  afterRatio: number[];
};

export type CashBufferResult = { points: CashBufferPoint[]; events: CashRebalanceEvent[] };

// Both levels fire on the same 10 percentage-point drift threshold (matching
// DCA's own threshold-rebalance rule).
const DRIFT_THRESHOLD_PCT = 10;

export function simulateCashBuffer(
  tickerSeries: { ticker: string; data: SeriesPoint[] }[],
  weights: Record<string, number>,
  options: { monthlyAmount?: number; cashRatio?: number } = {},
): CashBufferResult {
  if (tickerSeries.length === 0) return { points: [], events: [] };

  const monthlyAmount = options.monthlyAmount ?? 100;
  const targetCashRatio = Math.min(1, Math.max(0, options.cashRatio ?? 0.2));

  const totalWeight = tickerSeries.reduce((sum, t) => sum + (weights[t.ticker] ?? 0), 0);
  if (totalWeight <= 0) return { points: [], events: [] };
  const normalizedWeights = tickerSeries.map((t) => (weights[t.ticker] ?? 0) / totalWeight);
  const targetTickerPct = normalizedWeights.map((w) => w * 100);

  const dates = tickerSeries[0].data.map((d) => d.date);
  const prices = tickerSeries.map((t) => t.data.map((d) => d.value));
  const n = dates.length;

  const shares = new Array(tickerSeries.length).fill(0);
  let cashPool = 0;
  let invested = 0;
  let lastMonthKey = "";

  function investedValueAt(i: number) {
    let v = 0;
    for (let j = 0; j < tickerSeries.length; j++) v += shares[j] * prices[j][i];
    return v;
  }

  const points: CashBufferPoint[] = [];
  const events: CashRebalanceEvent[] = [];

  for (let i = 0; i < n; i++) {
    const date = dates[i];
    const monthKey = date.slice(0, 7);

    if (monthKey !== lastMonthKey) {
      lastMonthKey = monthKey;
      invested += monthlyAmount;
      cashPool += monthlyAmount * targetCashRatio;
      for (let j = 0; j < tickerSeries.length; j++) {
        const price = prices[j][i];
        if (price > 0) {
          shares[j] += (normalizedWeights[j] * monthlyAmount * (1 - targetCashRatio)) / price;
        }
      }
    }

    // Level 1: cash vs the stock sleeve as a whole. Buys/sells stock
    // proportionally across tickers by their CURRENT relative weight, so
    // this never disturbs the ticker-vs-ticker balance checked below.
    {
      const investedValue = investedValueAt(i);
      const totalValue = investedValue + cashPool;
      if (totalValue > 0) {
        const cashPct = (cashPool / totalValue) * 100;
        const targetCashPct = targetCashRatio * 100;
        if (Math.abs(cashPct - targetCashPct) >= DRIFT_THRESHOLD_PCT - 1e-9) {
          const diff = totalValue * targetCashRatio - cashPool;
          if (investedValue > 0 && Math.abs(diff) > 1e-6) {
            if (diff > 0) {
              const fraction = Math.min(1, diff / investedValue);
              for (let j = 0; j < tickerSeries.length; j++) shares[j] *= 1 - fraction;
              cashPool += diff;
            } else {
              const buyAmount = Math.min(-diff, cashPool);
              for (let j = 0; j < tickerSeries.length; j++) {
                const price = prices[j][i];
                const currentTickerValue = shares[j] * price;
                if (price > 0) {
                  shares[j] += ((currentTickerValue / investedValue) * buyAmount) / price;
                }
              }
              cashPool -= buyAmount;
            }
            events.push({
              date,
              level: "cash",
              beforeRatio: [
                Math.round(cashPct * 10) / 10,
                Math.round((100 - cashPct) * 10) / 10,
              ],
              afterRatio: [
                Math.round(targetCashPct * 10) / 10,
                Math.round((100 - targetCashPct) * 10) / 10,
              ],
            });
          }
        }
      }
    }

    // Level 2: ticker vs ticker, within the stock sleeve only - cash is
    // never touched here.
    {
      const investedValue = investedValueAt(i);
      if (investedValue > 0) {
        const currentTickerPct = shares.map(
          (sh, j) => ((sh * prices[j][i]) / investedValue) * 100,
        );
        const drifted = currentTickerPct.some(
          (pct, j) => Math.abs(pct - targetTickerPct[j]) >= DRIFT_THRESHOLD_PCT - 1e-9,
        );
        if (drifted) {
          events.push({
            date,
            level: "stock",
            beforeRatio: currentTickerPct.map((pct) => Math.round(pct * 10) / 10),
            afterRatio: targetTickerPct.map((pct) => Math.round(pct * 10) / 10),
          });
          for (let j = 0; j < tickerSeries.length; j++) {
            const price = prices[j][i];
            if (price > 0) shares[j] = (normalizedWeights[j] * investedValue) / price;
          }
        }
      }
    }

    const investedValue = investedValueAt(i);
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
