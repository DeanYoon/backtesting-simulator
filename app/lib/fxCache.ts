import { fetchHistory } from "./api";

const CACHE_KEY = "fx-history-cache-v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refetch at most once a day
const FX_SYMBOLS = ["KRW=X", "JPY=X"];

type ClosePricePoint = { date: string; close: number };
type FxHistory = Record<string, ClosePricePoint[]>;
type FxCache = { fetchedAt: number; data: FxHistory };

function readCache(): FxCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as FxCache;
  } catch {
    return null;
  }
}

function writeCache(cache: FxCache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full/unavailable - the cache is just an optimization, so it's
    // fine to silently skip persisting it.
  }
}

// Returns the KRW=X/JPY=X history needed to convert between USD, KRW and
// JPY - from localStorage if it was fetched within the last day, otherwise
// fetches the full history fresh and re-caches it. Always fetched at the
// deepest ("max") period regardless of the currently selected chart period,
// since the date-intersection in buildNormalizedSeries trims it down anyway.
export async function getFxHistory(): Promise<FxHistory> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetchHistory(FX_SYMBOLS, "max");
  writeCache({ fetchedAt: Date.now(), data });
  return data;
}
