"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Filler,
  type ChartType,
  type Plugin,
} from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";
import "chartjs-adapter-date-fns";
import {
  computeCalmarRatio,
  computeMaxDrawdown,
  computePearsonCorrelation,
  computeRollingCAGR,
  computeSharpeRatio,
  computeSortinoRatio,
  findParetoFrontier,
  generateWeightCombinations,
  summarizeRollingCAGR,
} from "@/app/lib/metrics";
import { calcMDDSegments } from "@/app/lib/mdd";
import { computeVolatilityThresholds, simulateDCA, type RebalanceEvent } from "@/app/lib/dca";
import { simulateCashBuffer, type CashRebalanceEvent } from "@/app/lib/cashBuffer";
import { combineWeightedSeries } from "@/app/lib/portfolio";
import { CURRENCIES, CURRENCY_LABELS } from "@/app/lib/currency";
import type { Currency, SeriesPoint } from "@/app/lib/types";

// Registers the option shape for our local `deepDrawdownLines` plugin so
// `options.plugins.deepDrawdownLines` type-checks like any built-in plugin.
declare module "chart.js" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required to match Chart.js's own generic signature for declaration merging
  interface PluginOptionsByType<TType extends ChartType> {
    deepDrawdownLines?: { timestamps?: number[] };
  }
}

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Filler,
  zoomPlugin,
);

// Disables the default "grow in from the baseline" animation on initial
// render and data updates for every chart in this file.
Chart.defaults.animation = false;

// Draws a red dashed vertical line at each configured timestamp — used to
// mark the deep (-20%+) drawdown episodes on the DCA chart. Configured
// per-chart via `options.plugins.deepDrawdownLines.timestamps`.
const deepDrawdownLinePlugin: Plugin<"line"> = {
  id: "deepDrawdownLines",
  afterDatasetsDraw(chart) {
    const timestamps = (chart.options.plugins?.deepDrawdownLines?.timestamps ?? []) as number[];
    if (timestamps.length === 0) return;

    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    if (!xScale) return;

    ctx.save();
    ctx.strokeStyle = "rgba(231, 76, 60, 0.75)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    for (const ts of timestamps) {
      const x = xScale.getPixelForValue(ts);
      if (x < chartArea.left || x > chartArea.right) continue;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
    }
    ctx.restore();
  },
};

const DAY_MS = 1000 * 60 * 60 * 24;
const YEAR_MS = DAY_MS * 365.25;
const MIN_ZOOM_RANGE_MS = DAY_MS * 14;
const PEAK_COLOR = "#e74c3c";
const TROUGH_COLOR = "#3498db";
const MARKER_RING_COLOR = "#0f0f1a";
const COMBO_COLOR = "#4a4a6a";
const PARETO_COLOR = "#16a085";
const CURRENT_COMBO_COLOR = "#f1c40f";
const CASH_COLOR = "#e67e22";
const DCA_REBAL_COLOR = "#3498db";
// Cash<->stock rebalance markers use CURRENT_COMBO_COLOR (gold); ticker-vs-
// ticker rebalance markers use this distinct purple so the two rebalance
// types are visually distinguishable at a glance on the chart.
const STOCK_REBAL_COLOR = "#9b59b6";
// Threshold for counting "deep" drawdown episodes in the DCA summary.
const DEEP_DRAWDOWN_THRESHOLD = 0.2;

export type ChartSeries = {
  id: string;
  label: string;
  color: string;
  data: SeriesPoint[];
};

// A peak/trough pair is only confirmed once a real (>=5%) decline has
// happened between them — an uninterrupted climb (even one with small
// sub-5% wobbles) only ever gets a single red dot, at whichever point is
// currently the all-time high.
const TROUGH_DROP_THRESHOLD = 0.05;

// Simple CAGR-style annualization of a total return over the given date
// span - treats the total (finalValue / invested) growth as if it compounded
// evenly over the whole period, ignoring the actual timing of individual DCA
// contributions.
function annualizedReturnPct(
  finalValue: number,
  invested: number,
  startDate: string,
  endDate: string,
): number | null {
  if (invested <= 0 || finalValue <= 0) return null;
  const years = (new Date(endDate).getTime() - new Date(startDate).getTime()) / YEAR_MS;
  if (years <= 0) return null;
  return (Math.pow(finalValue / invested, 1 / years) - 1) * 100;
}

// Renders a weight combination as "A:B:C 10:30:60" instead of
// "A 10% · B 30% · C 60%" - putting the tickers and their ratio on their own
// halves reads faster once there are 3+ assets.
function formatWeightRatio(tickers: { label: string }[], weightsArray: number[]): string {
  return `${tickers.map((t) => t.label).join(":")} ${weightsArray.join(":")}`;
}

function findPeaksAndTroughs(values: number[]) {
  const peakIndices = new Set<number>();
  const troughIndices = new Set<number>();
  const troughDrop = new Map<number, number>();
  const n = values.length;
  if (n === 0) return { peakIndices, troughIndices, troughDrop };

  let runningMax = values[0];
  let runningMaxIndex = 0;
  let drawdownMinValue = values[0];
  let drawdownMinIndex = 0;

  const confirmIfSignificant = () => {
    if (drawdownMinIndex === runningMaxIndex) return;
    const dropRatio = (runningMax - drawdownMinValue) / runningMax;
    if (dropRatio >= TROUGH_DROP_THRESHOLD) {
      peakIndices.add(runningMaxIndex);
      troughIndices.add(drawdownMinIndex);
      troughDrop.set(drawdownMinIndex, dropRatio);
    }
  };

  for (let i = 1; i < n; i++) {
    if (values[i] > runningMax) {
      confirmIfSignificant();
      runningMax = values[i];
      runningMaxIndex = i;
      drawdownMinValue = values[i];
      drawdownMinIndex = i;
    } else if (values[i] < drawdownMinValue) {
      drawdownMinValue = values[i];
      drawdownMinIndex = i;
    }
  }

  // Trailing, not-yet-recovered decline: still counts once it has stopped
  // making new lows before the data ends.
  if (drawdownMinIndex !== n - 1) {
    confirmIfSignificant();
  }

  // Always mark the current standing peak, even with no confirmed decline
  // since — otherwise an uninterrupted climb would show no marker at all.
  peakIndices.add(runningMaxIndex);

  return { peakIndices, troughIndices, troughDrop };
}

// Marker circle size — a bit bigger than the base line-point size so it's
// a comfortable hover target since hovering requires literally landing on
// the dot.
const MARKER_RADIUS = 6;
const MARKER_HOVER_RADIUS = 9;

type MarkerInfo = { kind: "peak" | "trough"; dropRatio?: number };
type Tab = "growth" | "risk" | "dca" | "cashbuffer";

type ComboPoint = {
  weights: number[];
  returnPct: number;
  mddPct: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  positiveCount?: number;
  totalCount?: number;
  label: string;
};

type RiskMode = "rolling" | "lumpsum";

export function PortfolioChart({
  series,
  weights = {},
  displayCurrency,
  onCurrencyChange,
  currencyLoading,
  onApplyWeights,
}: {
  series: ChartSeries[];
  weights?: Record<string, number>;
  displayCurrency?: Currency;
  onCurrencyChange?: (currency: Currency) => void;
  currencyLoading?: boolean;
  onApplyWeights?: (weights: Record<string, number>) => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("growth");
  const growthCanvasRef = useRef<HTMLCanvasElement>(null);
  const riskCanvasRef = useRef<HTMLCanvasElement>(null);
  const dcaCanvasRef = useRef<HTMLCanvasElement>(null);
  const cashBufferCanvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const riskChartRef = useRef<Chart | null>(null);
  const dcaChartRef = useRef<Chart | null>(null);
  const cashBufferChartRef = useRef<Chart | null>(null);
  const [dcaEmpty, setDcaEmpty] = useState<string | null>(null);
  const [dcaSummary, setDcaSummary] = useState<
    {
      key: string;
      label: string;
      finalValue: number;
      invested: number;
      returnPct: number;
      annualizedReturnPct: number | null;
      mddPct: number;
      // each entry is one -20%+ drawdown episode's drop, as a negative fraction
      deepDrawdowns: number[];
    }[]
  >([]);
  const [dcaEvents, setDcaEvents] = useState<(RebalanceEvent & { tickerLabels: string[] })[]>([]);
  const [dcaVolatilityEvents, setDcaVolatilityEvents] = useState<
    (RebalanceEvent & { tickerLabels: string[] })[]
  >([]);
  const [dcaVolatilityThresholds, setDcaVolatilityThresholds] = useState<
    { label: string; thresholdPct: number }[]
  >([]);
  const [cashRatioInput, setCashRatioInput] = useState("20");
  const [cashBufferEmpty, setCashBufferEmpty] = useState<string | null>(null);
  const [cashBufferSummary, setCashBufferSummary] = useState<
    {
      label: string;
      finalValue: number;
      invested: number;
      returnPct: number;
      annualizedReturnPct: number | null;
      mddPct: number;
    }[]
  >([]);
  const [cashBufferEvents, setCashBufferEvents] = useState<
    (CashRebalanceEvent & { tickerLabels: string[] })[]
  >([]);
  const [cashBufferDcaEvents, setCashBufferDcaEvents] = useState<
    (RebalanceEvent & { tickerLabels: string[] })[]
  >([]);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [baseDateLabel, setBaseDateLabel] = useState<string | null>(null);
  const [holdingYearsInput, setHoldingYearsInput] = useState("1");
  // Holding period can't reach (let alone exceed) the actual span of loaded
  // data, or there wouldn't be room for a single rolling window.
  const dataSpanYears = useMemo(() => {
    const data = series[0]?.data;
    if (!data || data.length < 2) return null;
    const first = new Date(data[0].date).getTime();
    const last = new Date(data[data.length - 1].date).getTime();
    return (last - first) / (1000 * 60 * 60 * 24 * 365.25);
  }, [series]);
  const maxHoldingYears =
    dataSpanYears !== null ? Math.max(0.5, dataSpanYears - 0.5) : undefined;
  const holdingYears = Math.min(
    Math.max(0.5, Number(holdingYearsInput) || 1),
    maxHoldingYears ?? Infinity,
  );
  const [riskMode, setRiskMode] = useState<RiskMode>("rolling");
  const [riskEmpty, setRiskEmpty] = useState<string | null>(null);
  const [paretoCombos, setParetoCombos] = useState<ComboPoint[]>([]);
  const riskDetailRef = useRef<Map<string, ComboPoint>>(new Map());
  const [mddSeriesId, setMddSeriesId] = useState<string | null>(null);

  // Original (unrebased) values, kept so every rebase starts from a clean
  // reference instead of compounding rounding error onto the last rebase.
  const timestampsRef = useRef<number[]>([]);
  const datesRef = useRef<string[]>([]);
  const originalValuesRef = useRef<number[][]>([]);

  // Lookup used by the tooltip to describe whichever marker point is active.
  const markerInfoRef = useRef<Map<string, MarkerInfo>>(new Map());

  function isVisible(id: string) {
    return visible[id] ?? id === "portfolio";
  }

  function toggle(id: string) {
    setVisible((prev) => ({ ...prev, [id]: !isVisible(id) }));
  }

  // Re-indexes every series so the value at `baseIndex` becomes 10,000 and
  // everything else is scaled relative to it.
  function applyRebase(baseIndex: number) {
    const chart = chartRef.current;
    if (!chart) return;

    const timestamps = timestampsRef.current;
    const values = originalValuesRef.current;

    chart.data.datasets.forEach((dataset, i) => {
      const base = values[i]?.[baseIndex];
      if (!base) return;
      dataset.data = timestamps.map((t, idx) => ({
        x: t,
        y: Math.round((values[i][idx] / base) * 10000),
      }));
    });
    chart.update("none");
    setBaseDateLabel(baseIndex === 0 ? null : datesRef.current[baseIndex]);
  }

  // Finds the leftmost currently-visible data point and rebases to it.
  function rebaseToVisibleStart() {
    const chart = chartRef.current;
    if (!chart) return;
    const visibleMin = chart.scales.x.min as number;
    const timestamps = timestampsRef.current;
    let index = timestamps.findIndex((t) => t >= visibleMin);
    if (index === -1) index = timestamps.length - 1;
    applyRebase(index);
  }

  // Growth (indexed value) chart.
  useEffect(() => {
    if (activeTab !== "growth" || !growthCanvasRef.current || series.length === 0) return;

    const timestamps = series[0].data.map((d) => new Date(d.date).getTime());
    const dates = series[0].data.map((d) => d.date);
    const values = series.map((s) => s.data.map((d) => d.value));
    timestampsRef.current = timestamps;
    datesRef.current = dates;
    originalValuesRef.current = values;
    setBaseDateLabel(null);

    const xMin = timestamps[0];
    const xMax = timestamps[timestamps.length - 1];

    const markerInfo = new Map<string, MarkerInfo>();

    chartRef.current = new Chart(growthCanvasRef.current, {
      type: "line",
      data: {
        datasets: series.map((s, i) => {
          const { peakIndices, troughIndices, troughDrop } =
            findPeaksAndTroughs(values[i]);
          const isMarker = (idx: number) =>
            peakIndices.has(idx) || troughIndices.has(idx);
          const pointRadius = values[i].map((_, idx) =>
            isMarker(idx) ? MARKER_RADIUS : 0,
          );
          const pointHoverRadius = values[i].map((_, idx) =>
            isMarker(idx) ? MARKER_HOVER_RADIUS : 0,
          );
          const pointHitRadius = values[i].map((_, idx) =>
            isMarker(idx) ? MARKER_RADIUS : 0,
          );
          const pointBackgroundColor = values[i].map((_, idx) =>
            peakIndices.has(idx)
              ? PEAK_COLOR
              : troughIndices.has(idx)
                ? TROUGH_COLOR
                : "transparent",
          );
          const pointBorderColor = values[i].map((_, idx) =>
            isMarker(idx) ? MARKER_RING_COLOR : "transparent",
          );

          peakIndices.forEach((idx) => {
            markerInfo.set(`${i}:${idx}`, { kind: "peak" });
          });
          troughIndices.forEach((idx) => {
            markerInfo.set(`${i}:${idx}`, {
              kind: "trough",
              dropRatio: troughDrop.get(idx),
            });
          });

          return {
            label: s.label,
            data: timestamps.map((t, idx) => ({ x: t, y: values[i][idx] })),
            borderColor: s.color,
            backgroundColor:
              s.id === "portfolio" ? `${s.color}20` : "transparent",
            borderWidth: s.id === "portfolio" ? 2.5 : 1.5,
            pointRadius,
            pointHoverRadius,
            pointHitRadius,
            pointBackgroundColor,
            pointBorderColor,
            pointBorderWidth: 2,
            fill: s.id === "portfolio",
            tension: 0.15,
            hidden: !isVisible(s.id),
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "point", intersect: true },
        scales: {
          x: {
            type: "time",
            time: { unit: "month", displayFormats: { month: "yyyy/M" } },
            min: xMin,
            max: xMax,
            grid: { color: "#1f1f38" },
            ticks: { color: "#888" },
          },
          y: {
            grid: { color: "#1f1f38" },
            ticks: {
              color: "#888",
              callback: (value) => Number(value).toLocaleString(),
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#1a1a2e",
            borderColor: "#2a2a4a",
            borderWidth: 1,
            callbacks: {
              label: (context) => {
                const base = `${context.dataset.label}: ${Number(context.parsed.y).toLocaleString()}`;
                const info = markerInfoRef.current.get(
                  `${context.datasetIndex}:${context.dataIndex}`,
                );
                if (!info) return base;
                if (info.kind === "peak") return `${base}  🔴 신고점`;
                if (info.dropRatio != null) {
                  return `${base}  🔵 반등저점 (고점 대비 -${(info.dropRatio * 100).toFixed(1)}%)`;
                }
                return `${base}  🔵 반등저점`;
              },
            },
          },
          zoom: {
            pan: {
              enabled: true,
              mode: "x",
              onPanComplete: () => rebaseToVisibleStart(),
            },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode: "x",
              onZoomComplete: () => rebaseToVisibleStart(),
            },
            limits: {
              x: {
                min: xMin,
                max: xMax,
                // prevents zooming in past ~2 weeks of data
                minRange: MIN_ZOOM_RANGE_MS,
              },
            },
          },
        },
      },
    });

    markerInfoRef.current = markerInfo;

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, activeTab]);

  // Risk/return scatter: grid-search every 10%-step weight combination
  // across the current tickers, plot each combo's return (y) against its
  // max drawdown (x — since MDD is <= 0, more negative naturally lands
  // further left, so "right = safer" falls out for free). Two ways to
  // measure "return": average rolling N-year holding-period CAGR, or a
  // single lump-sum invested at the very first date and held to the last.
  useEffect(() => {
    if (activeTab !== "risk" || !riskCanvasRef.current) return;

    const tickerSeries = series.filter((s) => s.id !== "portfolio");
    if (tickerSeries.length < 2) {
      setRiskEmpty("2개 이상의 종목이 있어야 비중 조합을 비교할 수 있습니다");
      setParetoCombos([]);
      return;
    }

    function computeMetrics(data: SeriesPoint[]) {
      const sharpe = computeSharpeRatio(data);
      const sortino = computeSortinoRatio(data);

      if (riskMode === "lumpsum") {
        if (data.length < 2 || data[0].value <= 0) return null;
        const first = data[0].value;
        const last = data[data.length - 1].value;
        const years =
          (new Date(data[data.length - 1].date).getTime() - new Date(data[0].date).getTime()) /
          YEAR_MS;
        const annualizedReturn = years > 0 ? Math.pow(last / first, 1 / years) - 1 : 0;
        const mddFraction = computeMaxDrawdown(data);
        return {
          returnPct: (last / first - 1) * 100,
          mddPct: mddFraction * 100,
          sharpe,
          sortino,
          calmar: computeCalmarRatio(annualizedReturn, mddFraction),
        };
      }
      const summary = summarizeRollingCAGR(computeRollingCAGR(data, holdingYears));
      if (!summary) return null;
      return {
        // Average, across every rolling window, of that window's own worst
        // intra-window drawdown — not the single worst drawdown over the
        // whole backtest period (that per-window detail only ever shows up
        // baked into this average, not as its own separate figure).
        returnPct: summary.avgCagr * 100,
        mddPct: summary.avgMaxDrawdown * 100,
        positiveCount: summary.positiveCount,
        totalCount: summary.total,
        sharpe,
        sortino,
        calmar: computeCalmarRatio(summary.avgCagr, summary.avgMaxDrawdown),
      };
    }

    const combos = generateWeightCombinations(tickerSeries.length);
    const comboPoints: ComboPoint[] = [];

    for (const combo of combos) {
      const combined = combineWeightedSeries(tickerSeries, combo);
      const metrics = computeMetrics(combined);
      if (!metrics) continue;
      comboPoints.push({
        weights: combo,
        ...metrics,
        label: formatWeightRatio(tickerSeries, combo),
      });
    }

    if (comboPoints.length === 0) {
      setRiskEmpty(
        riskMode === "lumpsum"
          ? "데이터가 부족합니다"
          : `데이터가 ${holdingYears}년 보유를 시뮬레이션하기에 부족합니다`,
      );
      setParetoCombos([]);
      return;
    }
    setRiskEmpty(null);

    const isPareto = findParetoFrontier(
      comboPoints.map((p) => ({ returnValue: p.returnPct, safety: p.mddPct })),
    );
    setParetoCombos(
      comboPoints.filter((_, i) => isPareto[i]).sort((a, b) => b.returnPct - a.returnPct),
    );

    // Pure single-asset (100%) points get their own ticker-colored dataset
    // instead of the generic gray/teal dots, so each ticker's own
    // risk/return is instantly recognizable by its portfolio color.
    const singleAssetIndices = new Set<number>();
    const singleAssetData = tickerSeries.map((t, j) => {
      const idx = comboPoints.findIndex((p) => p.weights[j] === 100);
      if (idx !== -1) singleAssetIndices.add(idx);
      return { ticker: t, point: idx !== -1 ? comboPoints[idx] : null };
    }).filter((d): d is { ticker: ChartSeries; point: ComboPoint } => d.point !== null);

    const paretoPoints = comboPoints.filter((_, i) => isPareto[i] && !singleAssetIndices.has(i));
    const normalPoints = comboPoints.filter((_, i) => !isPareto[i] && !singleAssetIndices.has(i));

    // Uses the live slider weights (not the last-analyzed "portfolio"
    // series), so the star always reflects whatever ratio is currently
    // selected even if it hasn't been re-analyzed yet.
    const currentWeightsArray = tickerSeries.map((t) => weights[t.id] ?? 0);
    const currentTotalWeight = currentWeightsArray.reduce((sum, w) => sum + w, 0);
    let currentPoint: ComboPoint | null = null;
    if (currentTotalWeight > 0) {
      const currentCombined = combineWeightedSeries(tickerSeries, currentWeightsArray);
      const metrics = computeMetrics(currentCombined);
      if (metrics) {
        currentPoint = {
          weights: currentWeightsArray,
          ...metrics,
          label: `현재 비중 (${formatWeightRatio(tickerSeries, currentWeightsArray)})`,
        };
      }
    }

    const details = new Map<string, ComboPoint>();
    normalPoints.forEach((p, i) => details.set(`0:${i}`, p));
    paretoPoints.forEach((p, i) => details.set(`1:${i}`, p));
    singleAssetData.forEach((d, i) => details.set(`2:${i}`, d.point));
    if (currentPoint) details.set(`3:0`, currentPoint);
    riskDetailRef.current = details;

    riskChartRef.current = new Chart(riskCanvasRef.current, {
      type: "line",
      data: {
        datasets: [
          {
            label: "조합",
            data: normalPoints.map((p) => ({ x: p.mddPct, y: p.returnPct })),
            showLine: false,
            pointRadius: 3,
            pointBackgroundColor: COMBO_COLOR,
            pointBorderColor: "transparent",
          },
          {
            label: "파레토 최적",
            data: paretoPoints.map((p) => ({ x: p.mddPct, y: p.returnPct })),
            showLine: false,
            pointRadius: 4,
            pointBackgroundColor: PARETO_COLOR,
            pointBorderColor: MARKER_RING_COLOR,
            pointBorderWidth: 1,
          },
          {
            label: "단일 종목 100%",
            data: singleAssetData.map((d) => ({ x: d.point.mddPct, y: d.point.returnPct })),
            showLine: false,
            pointRadius: 6,
            pointBackgroundColor: singleAssetData.map((d) => d.ticker.color),
            pointBorderColor: MARKER_RING_COLOR,
            pointBorderWidth: 1.5,
          },
          ...(currentPoint
            ? [
                {
                  label: "현재 비중",
                  data: [{ x: currentPoint.mddPct, y: currentPoint.returnPct }],
                  showLine: false,
                  pointRadius: 11,
                  pointHoverRadius: 13,
                  pointStyle: "star" as const,
                  pointBackgroundColor: CURRENT_COMBO_COLOR,
                  pointBorderColor: "#ffffff",
                  pointBorderWidth: 2,
                  order: 1,
                },
              ]
            : []),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: true },
        onClick: (_event, elements) => {
          if (elements.length === 0 || !onApplyWeights) return;
          const { datasetIndex, index } = elements[0];
          const detail = riskDetailRef.current.get(`${datasetIndex}:${index}`);
          if (!detail) return;
          onApplyWeights(
            Object.fromEntries(tickerSeries.map((t, i) => [t.id, detail.weights[i]])),
          );
        },
        onHover: (event, elements) => {
          const target = event.native?.target as HTMLElement | undefined;
          if (target) target.style.cursor = elements.length > 0 && onApplyWeights ? "pointer" : "default";
        },
        scales: {
          x: {
            type: "linear",
            grid: { color: "#1f1f38" },
            ticks: { color: "#888", callback: (value) => `${Number(value).toFixed(0)}%` },
            title: {
              display: true,
              text:
                riskMode === "lumpsum"
                  ? "최대 낙폭(MDD) — ← 위험 · 안전 →"
                  : "평균 최대 낙폭 — ← 위험 · 안전 →",
              color: "#888",
            },
          },
          y: {
            type: "linear",
            grid: { color: "#1f1f38" },
            ticks: { color: "#888", callback: (value) => `${Number(value).toFixed(0)}%` },
            title: {
              display: true,
              text:
                riskMode === "lumpsum"
                  ? "전체기간 누적 수익률 (처음 일시투자 기준)"
                  : `${holdingYears}년 보유 평균 수익률`,
              color: "#888",
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#1a1a2e",
            borderColor: "#2a2a4a",
            borderWidth: 1,
            callbacks: {
              title: (items) => {
                const item = items[0];
                if (!item) return "";
                const detail = riskDetailRef.current.get(`${item.datasetIndex}:${item.dataIndex}`);
                return detail?.label ?? "";
              },
              label: (context) => {
                const raw = context.raw as { x: number; y: number };
                const mddLabel = riskMode === "lumpsum" ? "MDD" : "평균 최대낙폭";
                const lines = [`수익률 ${raw.y.toFixed(2)}% · ${mddLabel} ${raw.x.toFixed(2)}%`];
                const detail = riskDetailRef.current.get(
                  `${context.datasetIndex}:${context.dataIndex}`,
                );
                if (detail?.totalCount != null && detail.positiveCount != null) {
                  const winRate =
                    detail.totalCount > 0
                      ? ((detail.positiveCount / detail.totalCount) * 100).toFixed(0)
                      : "0";
                  lines.push(
                    `수익 구간 ${detail.positiveCount}/${detail.totalCount} (${winRate}%)`,
                  );
                }
                if (detail) {
                  const fmt = (v: number | null) => (v == null ? "-" : v.toFixed(2));
                  lines.push(
                    `샤프 ${fmt(detail.sharpe)} · 소르티노 ${fmt(detail.sortino)} · 칼마 ${fmt(detail.calmar)}`,
                  );
                }
                return lines;
              },
            },
          },
        },
      },
    });

    return () => {
      riskChartRef.current?.destroy();
      riskChartRef.current = null;
    };
  }, [series, activeTab, holdingYears, riskMode, weights, onApplyWeights]);

  // DCA (dollar-cost-averaging) growth curve: simulate buying in fixed
  // monthly amounts at the current target weights, with and without
  // threshold rebalancing, alongside the cumulative principal invested.
  useEffect(() => {
    if (activeTab !== "dca" || !dcaCanvasRef.current) return;

    const tickerSeries = series.filter((s) => s.id !== "portfolio");
    if (tickerSeries.length === 0) {
      setDcaEmpty("종목이 없습니다");
      setDcaSummary([]);
      setDcaEvents([]);
      return;
    }

    const tickerInputs = tickerSeries.map((s) => ({ ticker: s.id, data: s.data }));
    const tickerLabels = tickerSeries.map((s) => s.label);
    const { points: noRebalance } = simulateDCA(tickerInputs, weights, { rebalanceMode: "none" });
    const { points: withRebalance, events: rebalanceEvents } = simulateDCA(tickerInputs, weights, {
      rebalanceMode: "threshold",
    });
    const { points: withVolatility, events: volatilityEvents } = simulateDCA(
      tickerInputs,
      weights,
      { rebalanceMode: "volatility" },
    );

    if (noRebalance.length === 0 || withRebalance.length === 0 || withVolatility.length === 0) {
      setDcaEmpty("데이터가 부족합니다");
      setDcaSummary([]);
      setDcaEvents([]);
      setDcaVolatilityEvents([]);
      setDcaVolatilityThresholds([]);
      return;
    }
    setDcaEmpty(null);
    setDcaEvents(rebalanceEvents.map((e) => ({ ...e, tickerLabels })));
    setDcaVolatilityEvents(volatilityEvents.map((e) => ({ ...e, tickerLabels })));
    const volatilityThresholds = computeVolatilityThresholds(tickerInputs);
    setDcaVolatilityThresholds(
      tickerLabels.map((label, i) => ({ label, thresholdPct: volatilityThresholds[i] })),
    );

    const xMin = new Date(noRebalance[0].date).getTime();
    const xMax = new Date(noRebalance[noRebalance.length - 1].date).getTime();

    const lastNo = noRebalance[noRebalance.length - 1];
    const lastWith = withRebalance[withRebalance.length - 1];
    const lastVolatility = withVolatility[withVolatility.length - 1];
    const noRebalanceSeries = noRebalance.map((p) => ({ date: p.date, value: p.value }));
    const withRebalanceSeries = withRebalance.map((p) => ({ date: p.date, value: p.value }));
    const withVolatilitySeries = withVolatility.map((p) => ({ date: p.date, value: p.value }));
    const noRebalanceDeepSegments = calcMDDSegments(noRebalanceSeries, DEEP_DRAWDOWN_THRESHOLD);
    setDcaSummary([
      {
        key: "no-rebal",
        label: "리밸런싱 없음",
        finalValue: lastNo.value,
        invested: lastNo.invested,
        returnPct: (lastNo.value / lastNo.invested - 1) * 100,
        annualizedReturnPct: annualizedReturnPct(
          lastNo.value,
          lastNo.invested,
          noRebalance[0].date,
          lastNo.date,
        ),
        mddPct: computeMaxDrawdown(noRebalanceSeries) * 100,
        deepDrawdowns: noRebalanceDeepSegments.map((seg) => seg.dropPct),
      },
      {
        key: "rebal",
        label: "비율 이탈 시 리밸런싱 (고정 10%p)",
        finalValue: lastWith.value,
        invested: lastWith.invested,
        returnPct: (lastWith.value / lastWith.invested - 1) * 100,
        annualizedReturnPct: annualizedReturnPct(
          lastWith.value,
          lastWith.invested,
          withRebalance[0].date,
          lastWith.date,
        ),
        mddPct: computeMaxDrawdown(withRebalanceSeries) * 100,
        deepDrawdowns: calcMDDSegments(withRebalanceSeries, DEEP_DRAWDOWN_THRESHOLD).map(
          (seg) => seg.dropPct,
        ),
      },
      {
        key: "volatility",
        label: "변동성 기준 리밸런싱",
        finalValue: lastVolatility.value,
        invested: lastVolatility.invested,
        returnPct: (lastVolatility.value / lastVolatility.invested - 1) * 100,
        annualizedReturnPct: annualizedReturnPct(
          lastVolatility.value,
          lastVolatility.invested,
          withVolatility[0].date,
          lastVolatility.date,
        ),
        mddPct: computeMaxDrawdown(withVolatilitySeries) * 100,
        deepDrawdowns: calcMDDSegments(withVolatilitySeries, DEEP_DRAWDOWN_THRESHOLD).map(
          (seg) => seg.dropPct,
        ),
      },
    ]);

    const eventDates = new Set(rebalanceEvents.map((e) => e.date));
    const rebalPointRadius = withRebalance.map((p) => (eventDates.has(p.date) ? 5 : 0));
    const rebalPointHoverRadius = withRebalance.map((p) => (eventDates.has(p.date) ? 7 : 4));
    const volatilityEventDates = new Set(volatilityEvents.map((e) => e.date));
    const volatilityPointRadius = withVolatility.map((p) =>
      volatilityEventDates.has(p.date) ? 5 : 0,
    );
    const volatilityPointHoverRadius = withVolatility.map((p) =>
      volatilityEventDates.has(p.date) ? 7 : 4,
    );
    const deepDrawdownTimestamps = noRebalanceDeepSegments.map((seg) =>
      new Date(seg.troughDate).getTime(),
    );

    dcaChartRef.current = new Chart(dcaCanvasRef.current, {
      type: "line",
      plugins: [deepDrawdownLinePlugin],
      data: {
        datasets: [
          {
            label: "누적 투자원금",
            data: noRebalance.map((p) => ({ x: new Date(p.date).getTime(), y: p.invested })),
            borderColor: "#6b6b85",
            borderDash: [4, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0,
          },
          {
            label: "DCA (리밸런싱 없음)",
            data: noRebalance.map((p) => ({ x: new Date(p.date).getTime(), y: p.value })),
            borderColor: COMBO_COLOR,
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.1,
          },
          {
            label: "DCA (비율 이탈 시 리밸런싱)",
            data: withRebalance.map((p) => ({ x: new Date(p.date).getTime(), y: p.value })),
            borderColor: PARETO_COLOR,
            borderWidth: 2,
            pointRadius: rebalPointRadius,
            pointHoverRadius: rebalPointHoverRadius,
            pointBackgroundColor: CURRENT_COMBO_COLOR,
            pointBorderColor: MARKER_RING_COLOR,
            pointBorderWidth: 1,
            fill: false,
            tension: 0.1,
          },
          {
            label: "DCA (변동성 기준 리밸런싱)",
            data: withVolatility.map((p) => ({ x: new Date(p.date).getTime(), y: p.value })),
            borderColor: DCA_REBAL_COLOR,
            borderWidth: 2,
            pointRadius: volatilityPointRadius,
            pointHoverRadius: volatilityPointHoverRadius,
            pointBackgroundColor: CURRENT_COMBO_COLOR,
            pointBorderColor: MARKER_RING_COLOR,
            pointBorderWidth: 1,
            fill: false,
            tension: 0.1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: "time",
            time: { unit: "month", displayFormats: { month: "yyyy/M" } },
            min: xMin,
            max: xMax,
            grid: { color: "#1f1f38" },
            ticks: { color: "#888" },
          },
          y: {
            grid: { color: "#1f1f38" },
            ticks: {
              color: "#888",
              callback: (value) => Number(value).toLocaleString(),
            },
          },
        },
        plugins: {
          legend: { labels: { color: "#cfcfe2" } },
          deepDrawdownLines: { timestamps: deepDrawdownTimestamps },
          tooltip: {
            backgroundColor: "#1a1a2e",
            borderColor: "#2a2a4a",
            borderWidth: 1,
            callbacks: {
              label: (context) => {
                const base = `${context.dataset.label}: ${Number(context.parsed.y).toLocaleString()}`;
                if (context.datasetIndex === 2 && eventDates.has(withRebalance[context.dataIndex].date)) {
                  return `${base}  🔁 리밸런싱`;
                }
                if (
                  context.datasetIndex === 3 &&
                  volatilityEventDates.has(withVolatility[context.dataIndex].date)
                ) {
                  return `${base}  🔁 리밸런싱`;
                }
                return base;
              },
            },
          },
          zoom: {
            pan: { enabled: true, mode: "x" },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode: "x",
            },
            limits: {
              x: {
                min: xMin,
                max: xMax,
                minRange: MIN_ZOOM_RANGE_MS,
              },
            },
          },
        },
      },
    });

    return () => {
      dcaChartRef.current?.destroy();
      dcaChartRef.current = null;
    };
  }, [series, activeTab, weights]);

  function handleDcaReset() {
    dcaChartRef.current?.resetZoom();
  }

  // Cash-buffer tactical strategy vs plain DCA vs DCA-with-rebalancing: hold
  // back part of each contribution as cash, and whenever cash or any
  // individual ticker's weight drifts 10%p or more from its target, rebalance
  // the whole position (cash included) back to target - same threshold rule
  // as the DCA tab's own rebalancing mode.
  useEffect(() => {
    if (activeTab !== "cashbuffer" || !cashBufferCanvasRef.current) return;

    const tickerSeries = series.filter((s) => s.id !== "portfolio");
    if (tickerSeries.length === 0) {
      setCashBufferEmpty("종목이 없습니다");
      setCashBufferSummary([]);
      return;
    }

    const cashRatio = Math.min(1, Math.max(0, (Number(cashRatioInput) || 0) / 100));
    const monthlyAmount = 100;

    const tickerInputs = tickerSeries.map((s) => ({ ticker: s.id, data: s.data }));
    const { points: pureDca } = simulateDCA(tickerInputs, weights, { rebalanceMode: "none" });
    // Same cash carve-out ratio as the cash-buffer strategy below, so the
    // comparison is apples-to-apples: only the invested (1 - cashRatio)
    // portion goes into tickers and gets threshold-rebalanced among them;
    // the cash portion just accumulates from monthly contributions,
    // untouched by any drawdown-based deploy/refill (unlike 현금버퍼, which
    // actively rebalances cash itself).
    const { points: dcaStockOnly, events: dcaRebalanceEvents } = simulateDCA(
      tickerInputs,
      weights,
      { rebalanceMode: "threshold", monthlyAmount: monthlyAmount * (1 - cashRatio) },
    );
    const dcaIdleCashAmount = monthlyAmount * cashRatio;
    let dcaIdleCashAccum = 0;
    let dcaIdleCashMonthKey = "";
    const dcaRebalanced = dcaStockOnly.map((p) => {
      const monthKey = p.date.slice(0, 7);
      if (monthKey !== dcaIdleCashMonthKey) {
        dcaIdleCashMonthKey = monthKey;
        dcaIdleCashAccum += dcaIdleCashAmount;
      }
      return {
        date: p.date,
        value: p.value + dcaIdleCashAccum,
        invested: p.invested + dcaIdleCashAccum,
      };
    });
    const { points: buffered, events: rebalanceEvents } = simulateCashBuffer(tickerInputs, weights, {
      cashRatio,
      monthlyAmount,
    });

    if (pureDca.length === 0 || dcaRebalanced.length === 0 || buffered.length === 0) {
      setCashBufferEmpty("데이터가 부족합니다");
      setCashBufferSummary([]);
      setCashBufferEvents([]);
      setCashBufferDcaEvents([]);
      return;
    }
    setCashBufferEmpty(null);
    const cashBufferTickerLabels = tickerSeries.map((s) => s.label);
    setCashBufferEvents(
      rebalanceEvents.map((e) => ({ ...e, tickerLabels: cashBufferTickerLabels })),
    );
    setCashBufferDcaEvents(
      dcaRebalanceEvents.map((e) => ({ ...e, tickerLabels: cashBufferTickerLabels })),
    );

    const lastDca = pureDca[pureDca.length - 1];
    const lastDcaRebalanced = dcaRebalanced[dcaRebalanced.length - 1];
    const lastBuffered = buffered[buffered.length - 1];
    setCashBufferSummary([
      {
        label: "순수 DCA",
        finalValue: lastDca.value,
        invested: lastDca.invested,
        returnPct: (lastDca.value / lastDca.invested - 1) * 100,
        annualizedReturnPct: annualizedReturnPct(
          lastDca.value,
          lastDca.invested,
          pureDca[0].date,
          lastDca.date,
        ),
        mddPct: computeMaxDrawdown(pureDca.map((p) => ({ date: p.date, value: p.value }))) * 100,
      },
      {
        label: "DCA (현금보유+리밸런싱)",
        finalValue: lastDcaRebalanced.value,
        invested: lastDcaRebalanced.invested,
        returnPct: (lastDcaRebalanced.value / lastDcaRebalanced.invested - 1) * 100,
        annualizedReturnPct: annualizedReturnPct(
          lastDcaRebalanced.value,
          lastDcaRebalanced.invested,
          dcaRebalanced[0].date,
          lastDcaRebalanced.date,
        ),
        mddPct:
          computeMaxDrawdown(dcaRebalanced.map((p) => ({ date: p.date, value: p.value }))) * 100,
      },
      {
        label: "현금버퍼",
        finalValue: lastBuffered.totalValue,
        invested: lastBuffered.invested,
        returnPct: (lastBuffered.totalValue / lastBuffered.invested - 1) * 100,
        annualizedReturnPct: annualizedReturnPct(
          lastBuffered.totalValue,
          lastBuffered.invested,
          buffered[0].date,
          lastBuffered.date,
        ),
        mddPct:
          computeMaxDrawdown(buffered.map((p) => ({ date: p.date, value: p.totalValue }))) * 100,
      },
    ]);

    const xMin = new Date(pureDca[0].date).getTime();
    const xMax = new Date(pureDca[pureDca.length - 1].date).getTime();

    const eventLevelByDate = new Map(rebalanceEvents.map((e) => [e.date, e.level]));
    const bufferPointRadius = buffered.map((p) => (eventLevelByDate.has(p.date) ? 5 : 0));
    const bufferPointHoverRadius = buffered.map((p) => (eventLevelByDate.has(p.date) ? 7 : 4));
    const bufferPointColor = buffered.map((p) =>
      eventLevelByDate.get(p.date) === "stock" ? STOCK_REBAL_COLOR : CURRENT_COMBO_COLOR,
    );

    const dcaEventDates = new Set(dcaRebalanceEvents.map((e) => e.date));
    const dcaRebalPointRadius = dcaRebalanced.map((p) => (dcaEventDates.has(p.date) ? 5 : 0));
    const dcaRebalPointHoverRadius = dcaRebalanced.map((p) =>
      dcaEventDates.has(p.date) ? 7 : 4,
    );

    cashBufferChartRef.current = new Chart(cashBufferCanvasRef.current, {
      type: "line",
      data: {
        datasets: [
          {
            label: "누적 투자원금",
            data: pureDca.map((p) => ({ x: new Date(p.date).getTime(), y: p.invested })),
            borderColor: "#6b6b85",
            borderDash: [4, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0,
          },
          {
            label: "순수 DCA",
            data: pureDca.map((p) => ({ x: new Date(p.date).getTime(), y: p.value })),
            borderColor: COMBO_COLOR,
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.1,
          },
          {
            label: "현금버퍼 총자산",
            data: buffered.map((p) => ({ x: new Date(p.date).getTime(), y: p.totalValue })),
            borderColor: PARETO_COLOR,
            borderWidth: 2,
            pointRadius: bufferPointRadius,
            pointHoverRadius: bufferPointHoverRadius,
            pointBackgroundColor: bufferPointColor,
            pointBorderColor: MARKER_RING_COLOR,
            pointBorderWidth: 1,
            fill: false,
            tension: 0.1,
          },
          {
            label: "순수 현금 보유액",
            data: buffered.map((p) => ({ x: new Date(p.date).getTime(), y: p.cashPool })),
            borderColor: CASH_COLOR,
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.1,
          },
          {
            label: "DCA (현금보유+리밸런싱)",
            data: dcaRebalanced.map((p) => ({ x: new Date(p.date).getTime(), y: p.value })),
            borderColor: DCA_REBAL_COLOR,
            borderWidth: 1.5,
            pointRadius: dcaRebalPointRadius,
            pointHoverRadius: dcaRebalPointHoverRadius,
            pointBackgroundColor: CURRENT_COMBO_COLOR,
            pointBorderColor: MARKER_RING_COLOR,
            pointBorderWidth: 1,
            fill: false,
            tension: 0.1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: "time",
            time: { unit: "month", displayFormats: { month: "yyyy/M" } },
            min: xMin,
            max: xMax,
            grid: { color: "#1f1f38" },
            ticks: { color: "#888" },
          },
          y: {
            grid: { color: "#1f1f38" },
            ticks: {
              color: "#888",
              callback: (value) => Number(value).toLocaleString(),
            },
          },
        },
        plugins: {
          legend: { labels: { color: "#cfcfe2" } },
          tooltip: {
            backgroundColor: "#1a1a2e",
            borderColor: "#2a2a4a",
            borderWidth: 1,
            callbacks: {
              label: (context) => {
                const base = `${context.dataset.label}: ${Number(context.parsed.y).toLocaleString()}`;
                if (
                  context.datasetIndex === 2 &&
                  eventLevelByDate.has(buffered[context.dataIndex].date)
                ) {
                  const event = rebalanceEvents.find(
                    (e) => e.date === buffered[context.dataIndex].date,
                  );
                  if (event) {
                    const labels = event.level === "cash" ? ["현금", "주식"] : cashBufferTickerLabels;
                    const detail = labels
                      .map((label, i) => `${label} ${event.beforeRatio[i]}%→${event.afterRatio[i]}%`)
                      .join(" · ");
                    const icon = event.level === "cash" ? "💰 현금 리밸런싱" : "🔄 종목 리밸런싱";
                    return `${base}  ${icon} (${detail})`;
                  }
                }
                if (
                  context.datasetIndex === 4 &&
                  dcaEventDates.has(dcaRebalanced[context.dataIndex].date)
                ) {
                  return `${base}  🔁 리밸런싱`;
                }
                return base;
              },
              afterBody: (items) => {
                if (items.length === 0) return [];
                const p = buffered[items[0].dataIndex];
                if (!p || p.totalValue <= 0) return [];
                const cashPct = (p.cashPool / p.totalValue) * 100;
                const stockPct = (p.investedValue / p.totalValue) * 100;
                return [`현금 ${cashPct.toFixed(1)}% · 주식 ${stockPct.toFixed(1)}%`];
              },
            },
          },
          zoom: {
            pan: { enabled: true, mode: "x" },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode: "x",
            },
            limits: {
              x: {
                min: xMin,
                max: xMax,
                minRange: MIN_ZOOM_RANGE_MS,
              },
            },
          },
        },
      },
    });

    return () => {
      cashBufferChartRef.current?.destroy();
      cashBufferChartRef.current = null;
    };
  }, [series, activeTab, weights, cashRatioInput]);

  function handleCashBufferReset() {
    cashBufferChartRef.current?.resetZoom();
  }

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    series.forEach((s, i) => {
      chart.setDatasetVisibility(i, isVisible(s.id));
    });
    chart.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, series]);

  function handleReset() {
    chartRef.current?.resetZoom();
    applyRebase(0);
  }

  const mddSegmentsBySeries = useMemo(
    () => series.map((s) => ({ id: s.id, label: s.label, color: s.color, segments: calcMDDSegments(s.data) })),
    [series],
  );
  const activeMddSeriesId = mddSegmentsBySeries.some((s) => s.id === mddSeriesId)
    ? mddSeriesId
    : (mddSegmentsBySeries[0]?.id ?? null);
  const activeMddSeries = mddSegmentsBySeries.find((s) => s.id === activeMddSeriesId) ?? null;
  const mddRows =
    activeMddSeries?.segments.map((seg, i) => ({
      key: `${activeMddSeries.id}-${i}`,
      seg,
    })) ?? [];

  function formatDays(days: number | null) {
    return days === null ? "진행중" : `${days}일`;
  }

  // Pairwise correlation of daily returns between every ticker (excluding
  // the blended "portfolio" series) - independent of weight combos, so it's
  // computed once from the raw series rather than inside the grid-search
  // effect.
  const correlationMatrix = useMemo(() => {
    const tickerSeries = series.filter((s) => s.id !== "portfolio");
    if (tickerSeries.length < 2) return null;
    const matrix = tickerSeries.map((a) =>
      tickerSeries.map((b) =>
        a.id === b.id ? 1 : computePearsonCorrelation(a.data, b.data),
      ),
    );
    return { tickers: tickerSeries, matrix };
  }, [series]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between gap-1.5 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setActiveTab("growth")}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition ${
              activeTab === "growth"
                ? "bg-blue text-white"
                : "bg-surface-2 text-muted hover:text-zinc-200"
            }`}
          >
            성장 그래프
          </button>
          <button
            onClick={() => setActiveTab("risk")}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition ${
              activeTab === "risk"
                ? "bg-blue text-white"
                : "bg-surface-2 text-muted hover:text-zinc-200"
            }`}
          >
            위험-수익
          </button>
          <button
            onClick={() => setActiveTab("dca")}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition ${
              activeTab === "dca"
                ? "bg-blue text-white"
                : "bg-surface-2 text-muted hover:text-zinc-200"
            }`}
          >
            DCA
          </button>
          <button
            onClick={() => setActiveTab("cashbuffer")}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition ${
              activeTab === "cashbuffer"
                ? "bg-blue text-white"
                : "bg-surface-2 text-muted hover:text-zinc-200"
            }`}
          >
            현금버퍼
          </button>
        </div>
        {displayCurrency && onCurrencyChange && (
          <div className="flex shrink-0 items-center gap-1">
            {currencyLoading && <span className="mr-1 text-[10.5px] text-muted">환율 불러오는 중...</span>}
            {CURRENCIES.map((c) => (
              <button
                key={c}
                onClick={() => onCurrencyChange(c)}
                title={CURRENCY_LABELS[c]}
                className={`h-7 rounded-md px-2.5 text-[11.5px] font-semibold transition ${
                  displayCurrency === c
                    ? "bg-purple text-white"
                    : "bg-surface-2 text-muted hover:text-zinc-200"
                }`}
              >
                {c === "USD" ? "달러" : c === "KRW" ? "원" : "엔"}
              </button>
            ))}
          </div>
        )}
      </div>
      {activeTab === "growth" && (
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        {series.map((s) => {
          const active = isVisible(s.id);
          return (
            <button
              key={s.id}
              onClick={() => toggle(s.id)}
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition"
              style={{
                borderColor: active ? s.color : "var(--border)",
                background: active ? s.color : "transparent",
                color: active ? "#fff" : "var(--muted)",
              }}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: active ? "#fff" : s.color }}
              />
              {s.label}
            </button>
          );
        })}
      </div>
      )}

      {activeTab === "growth" ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex items-center gap-3 text-[11px] text-muted">
              <span>
                {baseDateLabel
                  ? `기준일 ${baseDateLabel} = 10,000 · 드래그·휠로 다른 구간 비교`
                  : "드래그: 이동 · 휠: 확대/축소 (범위 제한)"}
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: PEAK_COLOR }}
                />
                신고점
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: TROUGH_COLOR }}
                />
                반등저점
              </span>
              <span>· 점 위에 마우스를 올리면 상세정보가 표시됩니다</span>
            </div>
            <button
              onClick={handleReset}
              className="h-7 rounded-md bg-[#555] px-3 text-[11.5px] text-white hover:bg-[#666]"
            >
              초기화
            </button>
          </div>
          <div className="relative min-h-105 flex-1 p-3">
            <canvas ref={growthCanvasRef} />
          </div>
          {mddSegmentsBySeries.length > 0 && (
            <div className="border-t border-border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-muted">
                  하락 구간 (고점 대비 5% 이상 낙폭 · 저점 이후 더 낮아지지 않은 구간만 표시)
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {mddSegmentsBySeries.map((s) => {
                    const active = s.id === activeMddSeriesId;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setMddSeriesId(s.id)}
                        className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition"
                        style={{
                          borderColor: active ? s.color : "var(--border)",
                          background: active ? s.color : "transparent",
                          color: active ? "#fff" : "var(--muted)",
                        }}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto overflow-x-auto">
                <table className="w-full min-w-140 text-[11.5px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-3 font-medium">시작일(고점)</th>
                      <th className="py-1 pr-3 font-medium">저점일</th>
                      <th className="py-1 pr-3 font-medium">회복일</th>
                      <th className="py-1 pr-3 font-medium">낙폭률</th>
                      <th className="py-1 pr-3 font-medium">낙폭기간</th>
                      <th className="py-1 pr-3 font-medium">회복기간</th>
                      <th className="py-1 pr-3 font-medium">전체소요</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {mddRows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-3 text-center font-sans text-muted">
                          5% 이상 하락 구간이 없습니다
                        </td>
                      </tr>
                    )}
                    {mddRows.map((r) => (
                      <tr key={r.key} className="border-t border-[#25253f]">
                        <td className="py-1.5 pr-3 text-zinc-300">{r.seg.peakDate}</td>
                        <td className="py-1.5 pr-3 text-zinc-300">{r.seg.troughDate}</td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {r.seg.recoveryDate ?? "진행중"}
                        </td>
                        <td className="py-1.5 pr-3 text-red">
                          {(r.seg.dropPct * 100).toFixed(1)}%
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {formatDays(r.seg.drawdownDays)}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {formatDays(r.seg.recoveryDays)}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {formatDays(r.seg.totalDays)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mddRows.length > 0 && (
                <div className="mt-2 text-[11px] text-muted">
                  총 <span className="font-mono text-zinc-200">{mddRows.length}</span>회 하락
                  (평균 낙폭{" "}
                  <span className="font-mono text-red">
                    {(
                      (mddRows.reduce((sum, r) => sum + r.seg.dropPct, 0) / mddRows.length) *
                      100
                    ).toFixed(1)}
                    %
                  </span>{" "}
                  · 최대 낙폭{" "}
                  <span className="font-mono text-red">
                    {(Math.min(...mddRows.map((r) => r.seg.dropPct)) * 100).toFixed(1)}%
                  </span>
                  )
                </div>
              )}
            </div>
          )}
        </>
      ) : activeTab === "risk" ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            <button
              onClick={() => setRiskMode("rolling")}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                riskMode === "rolling"
                  ? "bg-blue text-white"
                  : "bg-surface-2 text-muted hover:text-zinc-200"
              }`}
            >
              보유기간 롤링
            </button>
            <button
              onClick={() => setRiskMode("lumpsum")}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                riskMode === "lumpsum"
                  ? "bg-blue text-white"
                  : "bg-surface-2 text-muted hover:text-zinc-200"
              }`}
            >
              전체기간 일시투자
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-[11px] text-muted">
            {riskMode === "rolling" && (
              <span className="flex items-center gap-1.5">
                보유기간
                <input
                  type="number"
                  min={0.5}
                  max={maxHoldingYears}
                  step={0.5}
                  value={holdingYearsInput}
                  onChange={(e) => setHoldingYearsInput(e.target.value)}
                  className="h-6 w-14 rounded border border-border bg-surface-2 px-1.5 text-center font-mono text-[11.5px] text-foreground outline-none focus:border-blue"
                />
                년
                {maxHoldingYears !== undefined && (
                  <span className="text-muted">
                    (조회기간 내 최대 {maxHoldingYears.toFixed(1)}년)
                  </span>
                )}
              </span>
            )}
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: COMBO_COLOR }} />
              전체 조합
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: PARETO_COLOR }} />
              파레토 최적
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: CURRENT_COMBO_COLOR }} />
              현재 비중
            </span>
            {series
              .filter((s) => s.id !== "portfolio")
              .map((s) => (
                <span key={s.id} className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.label} 100%
                </span>
              ))}
            <span>
              ·{" "}
              {riskMode === "lumpsum"
                ? "종목 비중을 10%p 단위로 모두 조합해, 맨 처음 일시투자해서 마지막 날까지 들고 있었다면의 누적수익과 위험(MDD)을 비교합니다."
                : "종목 비중을 10%p 단위로 모두 조합해, 각 보유기간 구간에서 겪은 최대낙폭의 평균 대비 평균 수익을 비교합니다."}{" "}
              점을 클릭하면 그 비중이 왼쪽 슬라이더에 바로 적용됩니다.
            </span>
          </div>
          <div className="relative min-h-80 flex-1 p-3">
            <canvas ref={riskCanvasRef} />
            {riskEmpty && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface text-xs text-muted">
                {riskEmpty}
              </div>
            )}
          </div>
          {paretoCombos.length > 0 && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-1 text-[11px] text-muted">
                파레토 최적 조합 — 같은 위험에서 더 높은 수익, 또는 같은 수익에서 더 낮은
                위험인 조합만 남긴 목록입니다 (수익률 높은 순 정렬). 비중 구성은
                &quot;종목:종목 비율:비율&quot; 순서로 표시됩니다.
              </div>
              <ul className="mb-2 list-inside list-disc space-y-0.5 pl-0.5 text-[11px] text-muted marker:text-zinc-600">
                <li>
                  <span className="font-semibold text-zinc-300">샤프지수</span> = (연평균
                  수익률 − 무위험수익률) ÷ 변동성(표준편차). 상승·하락을 가리지 않고 &quot;가격이
                  얼마나 출렁였는지&quot; 전체를 위험으로 보고, 그 위험 대비 보상을 나타냅니다.
                  무위험수익률은 0%로 가정. 통상 1 이상이면 양호, 2 이상이면 우수한 편으로 봅니다.
                </li>
                <li>
                  <span className="font-semibold text-zinc-300">소르티노지수</span> = (연평균
                  수익률 − 무위험수익률) ÷ 하락 변동성. 계산 방식은 샤프지수와 비슷하지만
                  상승할 때의 출렁임은 위험으로 치지 않고, 손실이 난 날의 변동성만 분모에
                  반영합니다. 그래서 상승폭 자체는 큰 자산은 샤프보다 소르티노가 더 높게 나옵니다.
                </li>
                <li>
                  <span className="font-semibold text-zinc-300">칼마지수</span> = 연평균 수익률
                  ÷ |MDD|(최대낙폭의 절댓값). &quot;역대 최악의 하락 한 번&quot; 대비 얼마나
                  버는지를 보여주는 가장 단순한 지표입니다. 예: 연 18% 수익에 MDD -30%면 칼마
                  0.6.
                </li>
                <li>
                  세 지표 모두 <span className="font-semibold text-zinc-300">높을수록 좋고</span>,
                  가격이 거의 변하지 않아 변동성이 사실상 0에 가까우면 계산할 수 없어
                  &quot;-&quot;로 표시됩니다.
                </li>
              </ul>
              <div className="overflow-x-auto">
                <table className="w-full min-w-180 text-[11.5px]">
                  <thead>
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-3 font-medium">비중 구성</th>
                      <th className="py-1 pr-3 font-medium">수익률</th>
                      <th className="py-1 pr-3 font-medium">
                        {riskMode === "lumpsum" ? "MDD" : "평균 최대낙폭"}
                      </th>
                      {riskMode === "rolling" && (
                        <th className="py-1 pr-3 font-medium">수익 구간</th>
                      )}
                      <th className="py-1 pr-3 font-medium" title="(연평균수익률-무위험수익률)÷변동성">
                        샤프
                      </th>
                      <th
                        className="py-1 pr-3 font-medium"
                        title="(연평균수익률-무위험수익률)÷하락변동성"
                      >
                        소르티노
                      </th>
                      <th className="py-1 pr-3 font-medium" title="연평균수익률÷|MDD|">
                        칼마
                      </th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {paretoCombos.map((p) => (
                      <tr key={p.label} className="border-t border-[#25253f]">
                        <td className="py-1.5 pr-3 font-sans text-zinc-300">{p.label}</td>
                        <td className="py-1.5 pr-3 text-green">{p.returnPct.toFixed(2)}%</td>
                        <td className="py-1.5 pr-3 text-red">{p.mddPct.toFixed(2)}%</td>
                        {riskMode === "rolling" && (
                          <td className="py-1.5 pr-3 text-zinc-300">
                            {p.totalCount != null && p.positiveCount != null
                              ? `${p.positiveCount}/${p.totalCount} (${
                                  p.totalCount > 0
                                    ? ((p.positiveCount / p.totalCount) * 100).toFixed(0)
                                    : 0
                                }%)`
                              : "-"}
                          </td>
                        )}
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {p.sharpe == null ? "-" : p.sharpe.toFixed(2)}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {p.sortino == null ? "-" : p.sortino.toFixed(2)}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {p.calmar == null ? "-" : p.calmar.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {correlationMatrix && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-1 text-[11px] text-muted">
                종목간 상관관계 — 일별 수익률 기준 피어슨 상관계수(-1~1). 낮거나 음수일수록
                같이 움직이지 않는다는 뜻이라 분산투자 효과가 큽니다.
              </div>
              <ul className="mb-2 list-inside list-disc space-y-0.5 pl-0.5 text-[11px] text-muted marker:text-zinc-600">
                <li>
                  <span className="font-semibold text-green">낮음(0 이하)</span> — 서로 반대
                  또는 무관하게 움직임. 같이 담으면 변동성이 줄어드는 효과가 큽니다.
                </li>
                <li>
                  <span className="font-semibold text-zinc-300">중간(0~0.5)</span> — 어느 정도
                  같이 움직이지만 분산 효과가 아직 남아있습니다.
                </li>
                <li>
                  <span className="font-semibold text-red">높음(0.5 이상)</span> — 거의 같이
                  움직여서 두 종목을 같이 담아도 분산투자 효과가 작습니다.
                </li>
              </ul>
              <table className="w-full max-w-160 text-[11.5px]">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 pr-3 font-medium"></th>
                    {correlationMatrix.tickers.map((t) => (
                      <th key={t.id} className="py-1 pr-3 text-center font-medium">
                        {t.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {correlationMatrix.tickers.map((rowTicker, i) => (
                    <tr key={rowTicker.id} className="border-t border-[#25253f]">
                      <td className="py-1.5 pr-3 font-sans font-semibold text-zinc-300">
                        {rowTicker.label}
                      </td>
                      {correlationMatrix.matrix[i].map((value, j) => (
                        <td
                          key={correlationMatrix.tickers[j].id}
                          className={`py-1.5 pr-3 text-center ${
                            value == null
                              ? "text-muted"
                              : i === j
                                ? "text-zinc-500"
                                : value <= 0
                                  ? "text-green"
                                  : value < 0.5
                                    ? "text-zinc-300"
                                    : "text-red"
                          }`}
                        >
                          {value == null ? "-" : value.toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : activeTab === "dca" ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: "#6b6b85" }} />
                누적 투자원금
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: COMBO_COLOR }} />
                리밸런싱 없음
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: PARETO_COLOR }} />
                비율 이탈 시 리밸런싱 (고정 10%p)
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: DCA_REBAL_COLOR }} />
                변동성 기준 리밸런싱
              </span>
              <span className="flex items-center gap-1">
                <span className="h-3 w-0.5" style={{ background: "rgba(231, 76, 60, 0.85)" }} />
                -20% 이상 하락 시점
              </span>
              <span>
                · 매월 첫 거래일에 현재 비중대로 정액 매수하는 적립식(DCA) 시뮬레이션입니다.
                드래그: 이동 · 휠: 확대/축소
              </span>
            </div>
            <button
              onClick={handleDcaReset}
              className="h-7 shrink-0 rounded-md bg-[#555] px-3 text-[11.5px] text-white hover:bg-[#666]"
            >
              초기화
            </button>
          </div>
          {dcaVolatilityThresholds.length > 0 && (
            <div className="border-b border-border px-3 py-1.5 text-[11px] text-muted">
              변동성 기준 밴드 — 변동성이 큰 종목일수록 밴드를 넓혀(불필요한 리밸런싱 방지), 낮은
              종목일수록 좁혀서(작은 이탈도 포착) 종목마다 다른 기준을 적용합니다:{" "}
              {dcaVolatilityThresholds
                .map((t) => `${t.label} ±${t.thresholdPct.toFixed(1)}%p`)
                .join(" · ")}
            </div>
          )}
          <div className="relative min-h-80 flex-1 p-3">
            <canvas ref={dcaCanvasRef} />
            {dcaEmpty && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface text-xs text-muted">
                {dcaEmpty}
              </div>
            )}
          </div>
          {dcaSummary.length > 0 && (
            <div className="overflow-x-auto border-t border-border p-3">
              <table className="w-full min-w-100 text-[11.5px]">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 pr-3 font-medium">방식</th>
                    <th className="py-1 pr-3 font-medium">투자원금</th>
                    <th className="py-1 pr-3 font-medium">최종 평가액</th>
                    <th className="py-1 pr-3 font-medium">수익률</th>
                    <th className="py-1 pr-3 font-medium">연평균 수익률</th>
                    <th className="py-1 pr-3 font-medium">MDD</th>
                    <th className="py-1 pr-3 font-medium">-20% 이하 하락 횟수</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {dcaSummary.map((s) => (
                    <tr key={s.key} className="border-t border-[#25253f]">
                      <td className="py-1.5 pr-3 font-sans text-zinc-300">{s.label}</td>
                      <td className="py-1.5 pr-3 text-zinc-300">{s.invested.toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-zinc-300">{s.finalValue.toLocaleString()}</td>
                      <td className={`py-1.5 pr-3 ${s.returnPct >= 0 ? "text-green" : "text-red"}`}>
                        {s.returnPct >= 0 ? "+" : ""}
                        {s.returnPct.toFixed(2)}%
                      </td>
                      <td
                        className={`py-1.5 pr-3 ${(s.annualizedReturnPct ?? 0) >= 0 ? "text-green" : "text-red"}`}
                      >
                        {s.annualizedReturnPct == null
                          ? "-"
                          : `${s.annualizedReturnPct >= 0 ? "+" : ""}${s.annualizedReturnPct.toFixed(2)}%`}
                      </td>
                      <td className="py-1.5 pr-3 text-red">{s.mddPct.toFixed(2)}%</td>
                      <td className="py-1.5 pr-3 text-zinc-300">
                        {s.deepDrawdowns.length}회
                        {s.deepDrawdowns.length > 0 &&
                          ` (${s.deepDrawdowns.map((d) => `${(d * 100).toFixed(1)}%`).join(", ")})`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {dcaSummary.length > 1 && (
                <div className="mt-2 space-y-0.5 text-[11px] text-muted">
                  {dcaSummary.slice(1).map((s) => {
                    const base = dcaSummary[0];
                    const mddDiff = s.mddPct - base.mddPct;
                    const countDiff = s.deepDrawdowns.length - base.deepDrawdowns.length;
                    return (
                      <div key={s.key}>
                        {s.label} vs {base.label} — MDD 차이: {mddDiff.toFixed(2)}%p (
                        {mddDiff > 0 ? "낙폭이 더 큼" : mddDiff < 0 ? "낙폭이 더 작음" : "동일"}) ·
                        -20% 이하 하락 횟수 차이: {countDiff > 0 ? "+" : ""}
                        {countDiff}회
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {dcaEvents.length > 0 && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-2 text-[11px] text-muted">
                고정 10%p 리밸런싱 이력 (실제 비중이 10%p 구간을 넘어갈 때마다 목표 비중으로
                재조정)
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full min-w-100 text-[11.5px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-3 font-medium">날짜</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 전</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 후</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {dcaEvents.map((e) => (
                      <tr key={e.date} className="border-t border-[#25253f]">
                        <td className="py-1.5 pr-3 text-zinc-300">{e.date}</td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {e.tickerLabels.map((label, i) => `${label} ${e.beforeRatio[i]}%`).join(" · ")}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {e.tickerLabels.map((label, i) => `${label} ${e.afterRatio[i]}%`).join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {dcaVolatilityEvents.length > 0 && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-2 text-[11px] text-muted">
                변동성 기준 리밸런싱 이력 (종목마다 다른 밴드를 넘어갈 때마다 목표 비중으로
                재조정)
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full min-w-100 text-[11.5px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-3 font-medium">날짜</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 전</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 후</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {dcaVolatilityEvents.map((e) => (
                      <tr key={e.date} className="border-t border-[#25253f]">
                        <td className="py-1.5 pr-3 text-zinc-300">{e.date}</td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {e.tickerLabels.map((label, i) => `${label} ${e.beforeRatio[i]}%`).join(" · ")}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {e.tickerLabels.map((label, i) => `${label} ${e.afterRatio[i]}%`).join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-[11px] text-muted">
            <span className="flex items-center gap-1.5">
              현금비율
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={cashRatioInput}
                onChange={(e) => setCashRatioInput(e.target.value)}
                className="h-6 w-14 rounded border border-border bg-surface-2 px-1.5 text-center font-mono text-[11.5px] text-foreground outline-none focus:border-blue"
              />
              %
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: "#6b6b85" }} />
                누적 투자원금
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: COMBO_COLOR }} />
                순수 DCA
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: PARETO_COLOR }} />
                현금버퍼 총자산
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: CASH_COLOR }} />
                순수 현금 보유액
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: DCA_REBAL_COLOR }} />
                DCA (현금보유+리밸런싱)
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: CURRENT_COMBO_COLOR }}
                />
                현금⇄주식 리밸런싱 시점
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: STOCK_REBAL_COLOR }} />
                종목간 리밸런싱 시점
              </span>
              <span>
                · 매월 투입액 중 현금비율만큼은 현금으로 보유합니다. 현금:주식 비중과 종목간
                비중을 각각 독립적으로 - 목표 대비 10%p 이상 벗어나면 - 재조정합니다 (두 비율 모두
                항상 자기 안에서 합계 100%).
              </span>
            </div>
            <button
              onClick={handleCashBufferReset}
              className="h-7 shrink-0 rounded-md bg-[#555] px-3 text-[11.5px] text-white hover:bg-[#666]"
            >
              초기화
            </button>
          </div>
          <div className="relative min-h-80 flex-1 p-3">
            <canvas ref={cashBufferCanvasRef} />
            {cashBufferEmpty && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface text-xs text-muted">
                {cashBufferEmpty}
              </div>
            )}
          </div>
          {cashBufferSummary.length > 0 && (
            <div className="overflow-x-auto border-t border-border p-3">
              <table className="w-full min-w-100 text-[11.5px]">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 pr-3 font-medium">방식</th>
                    <th className="py-1 pr-3 font-medium">투자원금</th>
                    <th className="py-1 pr-3 font-medium">최종 평가액</th>
                    <th className="py-1 pr-3 font-medium">수익률</th>
                    <th className="py-1 pr-3 font-medium">연평균 수익률</th>
                    <th className="py-1 pr-3 font-medium">MDD</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {cashBufferSummary.map((s) => (
                    <tr key={s.label} className="border-t border-[#25253f]">
                      <td className="py-1.5 pr-3 font-sans text-zinc-300">{s.label}</td>
                      <td className="py-1.5 pr-3 text-zinc-300">{s.invested.toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-zinc-300">{s.finalValue.toLocaleString()}</td>
                      <td className={`py-1.5 pr-3 ${s.returnPct >= 0 ? "text-green" : "text-red"}`}>
                        {s.returnPct >= 0 ? "+" : ""}
                        {s.returnPct.toFixed(2)}%
                      </td>
                      <td
                        className={`py-1.5 pr-3 ${(s.annualizedReturnPct ?? 0) >= 0 ? "text-green" : "text-red"}`}
                      >
                        {s.annualizedReturnPct == null
                          ? "-"
                          : `${s.annualizedReturnPct >= 0 ? "+" : ""}${s.annualizedReturnPct.toFixed(2)}%`}
                      </td>
                      <td className="py-1.5 pr-3 text-red">{s.mddPct.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cashBufferEvents.some((e) => e.level === "cash") && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: CURRENT_COMBO_COLOR }}
                />
                현금⇄주식 리밸런싱 이력 (현금 비중이 목표 대비 10%p 이상 벗어날 때마다 재조정 -
                항상 현금%+주식%=100)
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full min-w-100 text-[11.5px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-3 font-medium">날짜</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 전</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 후</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {cashBufferEvents
                      .filter((e) => e.level === "cash")
                      .map((e, i) => (
                        <tr key={`${e.date}-${i}`} className="border-t border-[#25253f]">
                          <td className="py-1.5 pr-3 text-zinc-300">{e.date}</td>
                          <td className="py-1.5 pr-3 text-zinc-300">
                            {["현금", "주식"]
                              .map((label, i2) => `${label} ${e.beforeRatio[i2]}%`)
                              .join(" · ")}
                          </td>
                          <td className="py-1.5 pr-3 text-zinc-300">
                            {["현금", "주식"]
                              .map((label, i2) => `${label} ${e.afterRatio[i2]}%`)
                              .join(" · ")}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {cashBufferEvents.some((e) => e.level === "stock") && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: STOCK_REBAL_COLOR }}
                />
                종목간 리밸런싱 이력 (주식 안에서 종목 비중이 목표 대비 10%p 이상 벗어날 때마다
                재조정 - 항상 종목 비중 합계 100%, 현금은 무관)
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full min-w-100 text-[11.5px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-3 font-medium">날짜</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 전</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 후</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {cashBufferEvents
                      .filter((e) => e.level === "stock")
                      .map((e, i) => (
                        <tr key={`${e.date}-${i}`} className="border-t border-[#25253f]">
                          <td className="py-1.5 pr-3 text-zinc-300">{e.date}</td>
                          <td className="py-1.5 pr-3 text-zinc-300">
                            {e.tickerLabels
                              .map((label, i2) => `${label} ${e.beforeRatio[i2]}%`)
                              .join(" · ")}
                          </td>
                          <td className="py-1.5 pr-3 text-zinc-300">
                            {e.tickerLabels
                              .map((label, i2) => `${label} ${e.afterRatio[i2]}%`)
                              .join(" · ")}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {cashBufferDcaEvents.length > 0 && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-2 text-[11px] text-muted">
                DCA (현금보유+리밸런싱) 리밸런싱 이력 (현금비율만큼은 매월 그대로 보유하고, 나머지
                투자금 안에서 종목 비중이 목표 대비 10%p 이상 벗어날 때마다 종목 간 비율만
                재조정 - 현금 자체는 재조정 대상 아님)
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full min-w-100 text-[11.5px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-3 font-medium">날짜</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 전</th>
                      <th className="py-1 pr-3 font-medium">리밸런싱 후</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {cashBufferDcaEvents.map((e, i) => (
                      <tr key={`${e.date}-${i}`} className="border-t border-[#25253f]">
                        <td className="py-1.5 pr-3 text-zinc-300">{e.date}</td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {e.tickerLabels
                            .map((label, i2) => `${label} ${e.beforeRatio[i2]}%`)
                            .join(" · ")}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-300">
                          {e.tickerLabels
                            .map((label, i2) => `${label} ${e.afterRatio[i2]}%`)
                            .join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
