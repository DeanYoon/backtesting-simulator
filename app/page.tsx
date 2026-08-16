"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { TickerSearch } from "@/app/components/TickerSearch";
import { LocalFundPicker } from "@/app/components/LocalFundPicker";
import { PortfolioComposition } from "@/app/components/PortfolioComposition";
import { PeriodSelector, type Period } from "@/app/components/PeriodSelector";
import type { ChartSeries } from "@/app/components/PortfolioChart";
import { fetchHistory } from "@/app/lib/api";
import { generateExampleSeries } from "@/app/lib/mockData";
import { buildNormalizedSeries } from "@/app/lib/portfolio";
import { CURRENCY_LABELS, convertSeriesCurrency } from "@/app/lib/currency";
import { getFxHistory } from "@/app/lib/fxCache";
import type { Asset, Currency } from "@/app/lib/types";
import { LOCAL_FUND_CURRENCY, LOCAL_FUND_HISTORY } from "@/app/data/localFunds";
import defaultPortfolio from "@/app/data/default-portfolio.json";
import defaultHistory from "@/app/data/default-history.json";

const PORTFOLIO_COLOR = "#3d5afe";

const PortfolioChart = dynamic(
  () => import("@/app/components/PortfolioChart").then((m) => m.PortfolioChart),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-105 items-center justify-center rounded-lg border border-border bg-surface text-xs text-muted">
        차트 불러오는 중...
      </div>
    ),
  },
);

const PALETTE = [
  "#c0392b",
  "#1a5276",
  "#27ae60",
  "#f0a500",
  "#8e44ad",
  "#16a085",
  "#e67e22",
  "#3498db",
];

type ClosePricePoint = { date: string; close: number };

const INITIAL_ASSETS: Asset[] = defaultPortfolio.map((a, index) => ({
  id: a.ticker.toLowerCase(),
  ticker: a.ticker,
  weight: a.weight,
  color: PALETTE[index % PALETTE.length],
  currency: "USD",
}));

function createAsset(ticker: string, index: number): Asset {
  return {
    id: `${ticker}-${Date.now()}`,
    ticker,
    weight: 0,
    color: PALETTE[index % PALETTE.length],
    // Local funds carry their own known currency; anything else came from
    // the (US-centric) Yahoo Finance ticker search, so it defaults to USD.
    currency: LOCAL_FUND_CURRENCY[ticker] ?? "USD",
  };
}

// Converts each asset's raw (native-currency) price history into
// `currency` using that date's FX rate, then normalizes the result into
// chart series - pure/stateless so it can run both as the source of truth
// for `chartSeries` and as a dry-run validation before committing a new
// analyze result.
function deriveChartSeries(
  assetsForChart: Asset[],
  rawHistory: Record<string, ClosePricePoint[]>,
  fxHistory: Record<string, ClosePricePoint[]>,
  currency: Currency,
): { series: ChartSeries[] | null; error: string | null } {
  const convertedHistory: Record<string, ClosePricePoint[]> = {};
  for (const a of assetsForChart) {
    const raw = rawHistory[a.ticker];
    if (!raw) continue;
    const converted = convertSeriesCurrency(raw, a.currency, currency, fxHistory);
    if (!converted) {
      return {
        series: null,
        error: `${a.ticker} 데이터를 ${CURRENCY_LABELS[currency]}로 환산할 환율 데이터를 찾지 못했습니다.`,
      };
    }
    convertedHistory[a.ticker] = converted;
  }
  const normalized = buildNormalizedSeries(assetsForChart, convertedHistory);
  if (!normalized) {
    return { series: null, error: "겹치는 거래일 데이터를 찾지 못했습니다. 티커를 확인해주세요." };
  }
  return {
    series: [
      { id: "portfolio", label: "포트폴리오", color: PORTFOLIO_COLOR, data: normalized.portfolio },
      ...assetsForChart.map((a) => ({
        id: a.ticker,
        label: a.ticker,
        color: a.color,
        data: normalized.byTicker[a.ticker],
      })),
    ],
    error: null,
  };
}

export default function Home() {
  const [assets, setAssets] = useState<Asset[]>(INITIAL_ASSETS);
  const [period, setPeriod] = useState<Period>("10y");
  const [displayCurrency, setDisplayCurrency] = useState<Currency>("USD");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // The assets/raw price data actually behind the current chart - only
  // updated by an explicit "분석하기" click, so dragging a weight slider
  // never moves the chart on its own. Currency-button clicks reuse these as
  // -is and just re-derive with a different target currency (no re-fetch).
  const [analyzedAssets, setAnalyzedAssets] = useState<Asset[]>(INITIAL_ASSETS);
  const [rawHistory, setRawHistory] =
    useState<Record<string, ClosePricePoint[]>>(defaultHistory);
  const [fxHistory, setFxHistory] = useState<Record<string, ClosePricePoint[]>>({});
  const [currencyLoading, setCurrencyLoading] = useState(false);

  const [chartSeries, setChartSeries] = useState<ChartSeries[]>(() => {
    const result = deriveChartSeries(INITIAL_ASSETS, defaultHistory, {}, "USD");
    return (
      result.series ?? [
        { id: "example", label: "예시 포트폴리오", color: PORTFOLIO_COLOR, data: generateExampleSeries() },
      ]
    );
  });

  const totalWeight = assets.reduce((sum, a) => sum + a.weight, 0);
  const canAnalyze = assets.length > 0 && totalWeight === 100 && !isAnalyzing;
  // Stable reference unless `assets` itself changes, so PortfolioChart's
  // effects that depend on `weights` don't rebuild on unrelated re-renders.
  const weights = useMemo(
    () => Object.fromEntries(assets.map((a) => [a.ticker, a.weight])),
    [assets],
  );

  // FX rates are needed to display anything in a non-native currency, and
  // are kept warm (cached up to a day) from the moment the page loads so
  // the currency buttons feel instant rather than triggering a fetch.
  useEffect(() => {
    getFxHistory()
      .then(setFxHistory)
      .catch(() => {
        // Silent here - a currency switch that actually needs this data
        // will surface its own error when it fails to convert.
      });
  }, []);

  // Single source of truth for what the chart shows: re-derives whenever
  // the last-analyzed data or the chosen display currency changes.
  useEffect(() => {
    const result = deriveChartSeries(analyzedAssets, rawHistory, fxHistory, displayCurrency);
    if (result.series) {
      setChartSeries(result.series);
      setAnalyzeError(null);
    }
    // If derivation fails (e.g. FX still loading), keep showing whatever
    // was on screen rather than blanking the chart out.
  }, [analyzedAssets, rawHistory, fxHistory, displayCurrency]);

  // Returns FX history that's ready to use right now - the already-loaded
  // state if present, otherwise fetches (and caches) it fresh. Guards
  // against the race where a currency conversion is needed before the
  // mount-time background fetch has finished.
  async function ensureFxHistory(): Promise<Record<string, ClosePricePoint[]>> {
    if (Object.keys(fxHistory).length > 0) return fxHistory;
    const data = await getFxHistory();
    setFxHistory(data);
    return data;
  }

  async function handleAnalyze() {
    if (!canAnalyze) return;
    setIsAnalyzing(true);
    setAnalyzeError(null);
    try {
      // Locally-bundled funds (e.g. Japanese investment trusts with no
      // Yahoo Finance ticker) skip the API call entirely and use their
      // offline history instead.
      const apiTickers = assets
        .map((a) => a.ticker)
        .filter((ticker) => !(ticker in LOCAL_FUND_HISTORY));
      const apiHistory = apiTickers.length > 0 ? await fetchHistory(apiTickers, period) : {};
      const history: Record<string, ClosePricePoint[]> = { ...apiHistory, ...LOCAL_FUND_HISTORY };

      const needsFx = assets.some((a) => a.currency !== displayCurrency);
      const effectiveFx = needsFx ? await ensureFxHistory() : fxHistory;

      const result = deriveChartSeries(assets, history, effectiveFx, displayCurrency);
      if (!result.series) {
        setAnalyzeError(result.error);
        return;
      }
      setRawHistory(history);
      setAnalyzedAssets(assets);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "분석에 실패했습니다");
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleCurrencyChange(currency: Currency) {
    setDisplayCurrency(currency);
    if (currency !== "USD" && Object.keys(fxHistory).length === 0) {
      setCurrencyLoading(true);
      try {
        await ensureFxHistory();
      } catch {
        setAnalyzeError("환율 데이터를 가져오지 못했습니다.");
      } finally {
        setCurrencyLoading(false);
      }
    }
  }

  function handleAddTicker(ticker: string) {
    setAssets((prev) => {
      if (prev.some((a) => a.ticker === ticker)) return prev;
      return [...prev, createAsset(ticker, prev.length)];
    });
  }

  function handleWeightChange(id: string, weight: number) {
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, weight } : a)));
  }

  function handleRemove(id: string) {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }

  return (
    <div className="mx-auto flex w-full max-w-400 flex-col gap-4 px-5 py-5 lg:flex-row lg:items-start">
      <div className="flex w-full flex-col gap-3 lg:w-95 lg:shrink-0">
        <TickerSearch onAdd={handleAddTicker} />
        <LocalFundPicker onAdd={handleAddTicker} />
        <PortfolioComposition
          assets={assets}
          onWeightChange={handleWeightChange}
          onRemove={handleRemove}
        />
        <PeriodSelector value={period} onChange={setPeriod} />
        <button
          onClick={handleAnalyze}
          disabled={!canAnalyze}
          className="h-11 shrink-0 rounded-lg bg-blue text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
        >
          {isAnalyzing ? "분석 중..." : "분석하기"}
        </button>
        {!isAnalyzing && (assets.length === 0 || totalWeight !== 100) && (
          <p className="-mt-1.5 text-center text-[11px] text-muted">
            {assets.length === 0 ? "티커를 추가해주세요" : "비중 합계를 100%로 맞춰주세요"}
          </p>
        )}
        {analyzeError && (
          <p className="-mt-1.5 text-center text-[11px] text-red">{analyzeError}</p>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <PortfolioChart
          series={chartSeries}
          weights={weights}
          displayCurrency={displayCurrency}
          onCurrencyChange={handleCurrencyChange}
          currencyLoading={currencyLoading}
        />
      </div>
    </div>
  );
}
