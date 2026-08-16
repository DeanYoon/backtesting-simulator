import localFundHistory from "./local-fund-history.json";
import type { Currency } from "@/app/lib/types";

// Bundled offline price history for funds that aren't reachable through the
// Yahoo Finance search/history API (e.g. Japanese investment trusts, only
// identified by a local fund code). Keyed by the display name used as the
// asset's `ticker` throughout the app.
type ClosePricePoint = { date: string; close: number };

export const LOCAL_FUND_HISTORY: Record<string, ClosePricePoint[]> = localFundHistory;

export const LOCAL_FUND_TICKERS = Object.keys(LOCAL_FUND_HISTORY);

// Currency each local fund's raw price data is denominated in - needed to
// convert it correctly when the display currency differs.
export const LOCAL_FUND_CURRENCY: Record<string, Currency> = {
  "iFreeNEXT FANG+インデックス": "JPY",
};
