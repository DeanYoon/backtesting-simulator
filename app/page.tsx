"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { TickerSearch } from "@/app/components/TickerSearch";
import { PortfolioComposition } from "@/app/components/PortfolioComposition";
import { PeriodSelector, type Period } from "@/app/components/PeriodSelector";
import type { ChartSeries } from "@/app/components/PortfolioChart";
import { fetchHistory } from "@/app/lib/api";
import { generateExampleSeries } from "@/app/lib/mockData";
import { buildNormalizedSeries } from "@/app/lib/portfolio";
import type { Asset } from "@/app/lib/types";
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

const INITIAL_ASSETS: Asset[] = defaultPortfolio.map((a, index) => ({
  id: a.ticker.toLowerCase(),
  ticker: a.ticker,
  weight: a.weight,
  color: PALETTE[index % PALETTE.length],
}));

// Pre-fetched snapshot (10y QQQ/GLD) so the page has something real to show
// immediately on load, with no API round-trip needed.
const INITIAL_NORMALIZED = buildNormalizedSeries(INITIAL_ASSETS, defaultHistory);

function createAsset(ticker: string, index: number): Asset {
  return {
    id: `${ticker}-${Date.now()}`,
    ticker,
    weight: 0,
    color: PALETTE[index % PALETTE.length],
  };
}

export default function Home() {
  const [assets, setAssets] = useState<Asset[]>(INITIAL_ASSETS);
  const [chartSeries, setChartSeries] = useState<ChartSeries[]>(() => {
    if (INITIAL_NORMALIZED) {
      return [
        {
          id: "portfolio",
          label: "포트폴리오",
          color: PORTFOLIO_COLOR,
          data: INITIAL_NORMALIZED.portfolio,
        },
        ...INITIAL_ASSETS.map((a) => ({
          id: a.ticker,
          label: a.ticker,
          color: a.color,
          data: INITIAL_NORMALIZED.byTicker[a.ticker],
        })),
      ];
    }
    return [
      { id: "example", label: "예시 포트폴리오", color: PORTFOLIO_COLOR, data: generateExampleSeries() },
    ];
  });
  const [period, setPeriod] = useState<Period>("10y");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const totalWeight = assets.reduce((sum, a) => sum + a.weight, 0);
  const canAnalyze = assets.length > 0 && totalWeight === 100 && !isAnalyzing;
  // Stable reference unless `assets` itself changes, so PortfolioChart's
  // effects that depend on `weights` don't rebuild on unrelated re-renders.
  const weights = useMemo(
    () => Object.fromEntries(assets.map((a) => [a.ticker, a.weight])),
    [assets],
  );

  async function handleAnalyze() {
    if (!canAnalyze) return;
    setIsAnalyzing(true);
    setAnalyzeError(null);
    try {
      const history = await fetchHistory(
        assets.map((a) => a.ticker),
        period,
      );
      const normalized = buildNormalizedSeries(assets, history);
      if (!normalized) {
        setAnalyzeError("겹치는 거래일 데이터를 찾지 못했습니다. 티커를 확인해주세요.");
        return;
      }
      setChartSeries([
        { id: "portfolio", label: "포트폴리오", color: PORTFOLIO_COLOR, data: normalized.portfolio },
        ...assets.map((a) => ({
          id: a.ticker,
          label: a.ticker,
          color: a.color,
          data: normalized.byTicker[a.ticker],
        })),
      ]);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "분석에 실패했습니다");
    } finally {
      setIsAnalyzing(false);
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
        <PortfolioChart series={chartSeries} weights={weights} />
      </div>
    </div>
  );
}
