import type { SeriesPoint } from "./types";

export type NormalizedSeries = {
  portfolio: SeriesPoint[];
  byTicker: Record<string, SeriesPoint[]>;
};

// Only `date` and `close` are ever read from each price point — kept
// minimal (rather than the full HistoryResponse/HistoryPoint shape) so
// trimmed-down data sources (e.g. a pre-fetched JSON snapshot with only
// these two fields) can be passed in directly.
type ClosePricePoint = { date: string; close: number };
type ClosePriceHistory = Record<string, ClosePricePoint[]>;

// Normalizes each ticker to a common base (10000) at the first shared trading
// date so tickers with different price scales are directly comparable, then
// derives the weighted portfolio line from those normalized series.
export function buildNormalizedSeries(
  assets: { ticker: string; weight: number }[],
  history: ClosePriceHistory,
): NormalizedSeries | null {
  const totalWeight = assets.reduce((sum, a) => sum + a.weight, 0);
  if (assets.length === 0 || totalWeight <= 0) return null;

  const byDateMaps = assets.map((a) => {
    const points = history[a.ticker] ?? [];
    return new Map(points.map((p) => [p.date, p.close]));
  });

  if (byDateMaps.some((m) => m.size === 0)) return null;

  const commonDates = [...byDateMaps[0].keys()]
    .filter((date) => byDateMaps.every((m) => m.has(date)))
    .sort();

  if (commonDates.length === 0) return null;

  const baseValues = byDateMaps.map((m) => m.get(commonDates[0])!);

  const byTicker: Record<string, SeriesPoint[]> = {};
  assets.forEach((a, i) => {
    byTicker[a.ticker] = commonDates.map((date) => ({
      date,
      value: Math.round((byDateMaps[i].get(date)! / baseValues[i]) * 10000),
    }));
  });

  const portfolio = commonDates.map((date, dateIndex) => {
    const value = assets.reduce((sum, a) => {
      const weight = a.weight / totalWeight;
      return sum + byTicker[a.ticker][dateIndex].value * weight;
    }, 0);
    return { date, value: Math.round(value) };
  });

  return { portfolio, byTicker };
}

// Recombines already-normalized, date-aligned series with a different set
// of weights — used to re-price a portfolio under alternative weight
// combinations without re-fetching or re-normalizing from raw prices.
export function combineWeightedSeries(
  seriesList: { data: SeriesPoint[] }[],
  weights: number[],
): SeriesPoint[] {
  if (seriesList.length === 0) return [];
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return [];

  const length = seriesList[0].data.length;
  const combined: SeriesPoint[] = [];
  for (let i = 0; i < length; i++) {
    let value = 0;
    for (let j = 0; j < seriesList.length; j++) {
      value += seriesList[j].data[i].value * (weights[j] / totalWeight);
    }
    combined.push({ date: seriesList[0].data[i].date, value: Math.round(value) });
  }
  return combined;
}
