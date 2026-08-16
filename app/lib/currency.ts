import type { Currency } from "./types";

export const CURRENCIES: Currency[] = ["USD", "KRW", "JPY"];

export const CURRENCY_LABELS: Record<Currency, string> = {
  USD: "달러 ($)",
  KRW: "원 (₩)",
  JPY: "엔 (¥)",
};

// Yahoo Finance FX symbols express "how many units of this currency per 1
// USD" (e.g. KRW=X ≈ 1450 means 1 USD = 1450 KRW). There's no non-USD
// currency in this app yet, so every conversion crosses through USD.
const USD_CROSS_SYMBOL: Record<Exclude<Currency, "USD">, string> = {
  KRW: "KRW=X",
  JPY: "JPY=X",
};

type ClosePricePoint = { date: string; close: number };

// Converts a price series from `fromCurrency` to `toCurrency`, applying the
// FX rate that was actually in effect ON EACH DATE - not today's rate
// applied retroactively. Dates with no matching FX rate are dropped rather
// than guessed at. `fxHistory` is keyed by Yahoo FX symbol (e.g. "KRW=X").
export function convertSeriesCurrency(
  data: ClosePricePoint[],
  fromCurrency: Currency,
  toCurrency: Currency,
  fxHistory: Record<string, ClosePricePoint[]>,
): ClosePricePoint[] | null {
  if (fromCurrency === toCurrency) return data;

  const fromRateMap =
    fromCurrency === "USD"
      ? null
      : new Map(
          (fxHistory[USD_CROSS_SYMBOL[fromCurrency]] ?? []).map((p) => [p.date, p.close]),
        );
  const toRateMap =
    toCurrency === "USD"
      ? null
      : new Map((fxHistory[USD_CROSS_SYMBOL[toCurrency]] ?? []).map((p) => [p.date, p.close]));

  const result: ClosePricePoint[] = [];
  for (const point of data) {
    // Step 1: that date's rate converts the source currency to USD.
    let usdValue = point.close;
    if (fromRateMap) {
      const rate = fromRateMap.get(point.date);
      if (rate == null || rate <= 0) continue;
      usdValue = point.close / rate;
    }
    // Step 2: that same date's rate converts USD to the target currency.
    let converted = usdValue;
    if (toRateMap) {
      const rate = toRateMap.get(point.date);
      if (rate == null) continue;
      converted = usdValue * rate;
    }
    result.push({ date: point.date, close: converted });
  }
  return result.length > 0 ? result : null;
}
