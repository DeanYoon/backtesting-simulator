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
  computeMaxDrawdown,
  computeRollingCAGR,
  findParetoFrontier,
  generateWeightCombinations,
  summarizeRollingCAGR,
} from "@/app/lib/metrics";
import { calcMDDSegments } from "@/app/lib/mdd";
import { simulateDCA, type RebalanceEvent } from "@/app/lib/dca";
import { simulateCashBuffer, type CashDeployEvent } from "@/app/lib/cashBuffer";
import { combineWeightedSeries } from "@/app/lib/portfolio";
import type { SeriesPoint } from "@/app/lib/types";

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
const MIN_ZOOM_RANGE_MS = DAY_MS * 14;
const PEAK_COLOR = "#e74c3c";
const TROUGH_COLOR = "#3498db";
const MARKER_RING_COLOR = "#0f0f1a";
const COMBO_COLOR = "#4a4a6a";
const PARETO_COLOR = "#16a085";
const CURRENT_COMBO_COLOR = "#f1c40f";
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
  positiveCount?: number;
  totalCount?: number;
  label: string;
};

type RiskMode = "rolling" | "lumpsum";

export function PortfolioChart({
  series,
  weights = {},
}: {
  series: ChartSeries[];
  weights?: Record<string, number>;
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
      rebalanced: boolean;
      finalValue: number;
      invested: number;
      returnPct: number;
      mddPct: number;
      // each entry is one -20%+ drawdown episode's drop, as a negative fraction
      deepDrawdowns: number[];
    }[]
  >([]);
  const [dcaEvents, setDcaEvents] = useState<(RebalanceEvent & { tickerLabels: string[] })[]>([]);
  const [cashRatioInput, setCashRatioInput] = useState("20");
  const [trigger1Input, setTrigger1Input] = useState("-15");
  const [trigger2Input, setTrigger2Input] = useState("-25");
  const [cashBufferEmpty, setCashBufferEmpty] = useState<string | null>(null);
  const [cashBufferSummary, setCashBufferSummary] = useState<
    { label: string; finalValue: number; invested: number; returnPct: number; mddPct: number }[]
  >([]);
  const [cashBufferEvents, setCashBufferEvents] = useState<CashDeployEvent[]>([]);
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
      if (riskMode === "lumpsum") {
        if (data.length < 2 || data[0].value <= 0) return null;
        const first = data[0].value;
        const last = data[data.length - 1].value;
        return {
          returnPct: (last / first - 1) * 100,
          mddPct: computeMaxDrawdown(data) * 100,
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
        label: tickerSeries.map((t, i) => `${t.label} ${combo[i]}%`).join(" · "),
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
          label: `현재 비중 (${tickerSeries
            .map((t, i) => `${t.label} ${currentWeightsArray[i]}%`)
            .join(" · ")})`,
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
  }, [series, activeTab, holdingYears, riskMode, weights]);

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

    if (noRebalance.length === 0 || withRebalance.length === 0) {
      setDcaEmpty("데이터가 부족합니다");
      setDcaSummary([]);
      setDcaEvents([]);
      return;
    }
    setDcaEmpty(null);
    setDcaEvents(rebalanceEvents.map((e) => ({ ...e, tickerLabels })));

    const xMin = new Date(noRebalance[0].date).getTime();
    const xMax = new Date(noRebalance[noRebalance.length - 1].date).getTime();

    const lastNo = noRebalance[noRebalance.length - 1];
    const lastWith = withRebalance[withRebalance.length - 1];
    const noRebalanceSeries = noRebalance.map((p) => ({ date: p.date, value: p.value }));
    const withRebalanceSeries = withRebalance.map((p) => ({ date: p.date, value: p.value }));
    const noRebalanceDeepSegments = calcMDDSegments(noRebalanceSeries, DEEP_DRAWDOWN_THRESHOLD);
    setDcaSummary([
      {
        rebalanced: false,
        finalValue: lastNo.value,
        invested: lastNo.invested,
        returnPct: (lastNo.value / lastNo.invested - 1) * 100,
        mddPct: computeMaxDrawdown(noRebalanceSeries) * 100,
        deepDrawdowns: noRebalanceDeepSegments.map((seg) => seg.dropPct),
      },
      {
        rebalanced: true,
        finalValue: lastWith.value,
        invested: lastWith.invested,
        returnPct: (lastWith.value / lastWith.invested - 1) * 100,
        mddPct: computeMaxDrawdown(withRebalanceSeries) * 100,
        deepDrawdowns: calcMDDSegments(withRebalanceSeries, DEEP_DRAWDOWN_THRESHOLD).map(
          (seg) => seg.dropPct,
        ),
      },
    ]);

    const eventDates = new Set(rebalanceEvents.map((e) => e.date));
    const rebalPointRadius = withRebalance.map((p) => (eventDates.has(p.date) ? 5 : 0));
    const rebalPointHoverRadius = withRebalance.map((p) => (eventDates.has(p.date) ? 7 : 4));
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

  // Cash-buffer tactical strategy vs plain DCA: hold back part of each
  // contribution as cash, deploy it in tiers as the market draws down past
  // configured trigger levels, reset the triggers on every new high.
  useEffect(() => {
    if (activeTab !== "cashbuffer" || !cashBufferCanvasRef.current) return;

    const tickerSeries = series.filter((s) => s.id !== "portfolio");
    if (tickerSeries.length === 0) {
      setCashBufferEmpty("종목이 없습니다");
      setCashBufferSummary([]);
      return;
    }

    const cashRatio = Math.min(1, Math.max(0, (Number(cashRatioInput) || 0) / 100));
    const trigger1 = Math.min(0, Number(trigger1Input) || -15) / 100;
    const trigger2 = Math.min(0, Number(trigger2Input) || -25) / 100;

    const tickerInputs = tickerSeries.map((s) => ({ ticker: s.id, data: s.data }));
    const { points: pureDca } = simulateDCA(tickerInputs, weights, { rebalanceMode: "none" });
    const { points: buffered, events: deployEvents } = simulateCashBuffer(tickerInputs, weights, {
      cashRatio,
      triggerLevels: [trigger1, trigger2],
    });

    if (pureDca.length === 0 || buffered.length === 0) {
      setCashBufferEmpty("데이터가 부족합니다");
      setCashBufferSummary([]);
      setCashBufferEvents([]);
      return;
    }
    setCashBufferEmpty(null);
    setCashBufferEvents(deployEvents);

    const lastDca = pureDca[pureDca.length - 1];
    const lastBuffered = buffered[buffered.length - 1];
    setCashBufferSummary([
      {
        label: "순수 DCA",
        finalValue: lastDca.value,
        invested: lastDca.invested,
        returnPct: (lastDca.value / lastDca.invested - 1) * 100,
        mddPct: computeMaxDrawdown(pureDca.map((p) => ({ date: p.date, value: p.value }))) * 100,
      },
      {
        label: "현금버퍼",
        finalValue: lastBuffered.totalValue,
        invested: lastBuffered.invested,
        returnPct: (lastBuffered.totalValue / lastBuffered.invested - 1) * 100,
        mddPct:
          computeMaxDrawdown(buffered.map((p) => ({ date: p.date, value: p.totalValue }))) * 100,
      },
    ]);

    const xMin = new Date(pureDca[0].date).getTime();
    const xMax = new Date(pureDca[pureDca.length - 1].date).getTime();

    const eventDates = new Set(deployEvents.map((e) => e.date));
    const bufferPointRadius = buffered.map((p) => (eventDates.has(p.date) ? 5 : 0));
    const bufferPointHoverRadius = buffered.map((p) => (eventDates.has(p.date) ? 7 : 4));

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
                if (context.datasetIndex === 2 && eventDates.has(buffered[context.dataIndex].date)) {
                  const event = deployEvents.find((e) => e.date === buffered[context.dataIndex].date);
                  if (event) {
                    return `${base}  💰 현금 투입 (낙폭 ${(event.drawdown * 100).toFixed(1)}%, ${event.deployAmount.toLocaleString()} 투입)`;
                  }
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
      cashBufferChartRef.current?.destroy();
      cashBufferChartRef.current = null;
    };
  }, [series, activeTab, weights, cashRatioInput, trigger1Input, trigger2Input]);

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

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
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
                : "종목 비중을 10%p 단위로 모두 조합해, 각 보유기간 구간에서 겪은 최대낙폭의 평균 대비 평균 수익을 비교합니다."}
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
              <div className="mb-2 text-[11px] text-muted">
                파레토 최적 조합 (같은 위험에서 더 높은 수익, 또는 같은 수익에서 더 낮은
                위험인 조합만 남긴 것 — 수익률 높은 순)
              </div>
              <table className="w-full min-w-120 text-[11.5px]">
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
                비율 이탈 시 리밸런싱
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
                    <th className="py-1 pr-3 font-medium">MDD</th>
                    <th className="py-1 pr-3 font-medium">-20% 이하 하락 횟수</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {dcaSummary.map((s) => (
                    <tr key={s.rebalanced ? "rebal" : "no-rebal"} className="border-t border-[#25253f]">
                      <td className="py-1.5 pr-3 font-sans text-zinc-300">
                        {s.rebalanced ? "비율 이탈 시 리밸런싱" : "리밸런싱 없음"}
                      </td>
                      <td className="py-1.5 pr-3 text-zinc-300">{s.invested.toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-zinc-300">{s.finalValue.toLocaleString()}</td>
                      <td className={`py-1.5 pr-3 ${s.returnPct >= 0 ? "text-green" : "text-red"}`}>
                        {s.returnPct >= 0 ? "+" : ""}
                        {s.returnPct.toFixed(2)}%
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
              {dcaSummary.length === 2 && (
                <div className="mt-2 text-[11px] text-muted">
                  MDD 차이: {(dcaSummary[1].mddPct - dcaSummary[0].mddPct).toFixed(2)}%p (리밸런싱
                  {dcaSummary[1].mddPct > dcaSummary[0].mddPct ? " 시 낙폭이 더 큼" : " 시 낙폭이 더 작음"}) ·
                  -20% 이하 하락 횟수 차이:{" "}
                  {dcaSummary[1].deepDrawdowns.length - dcaSummary[0].deepDrawdowns.length}회
                </div>
              )}
            </div>
          )}
          {dcaEvents.length > 0 && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-2 text-[11px] text-muted">
                리밸런싱 이력 (실제 비중이 10%p 구간을 넘어갈 때마다 목표 비중으로 재조정)
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
            <span className="flex items-center gap-1.5">
              트리거1
              <input
                type="number"
                min={-90}
                max={-1}
                step={5}
                value={trigger1Input}
                onChange={(e) => setTrigger1Input(e.target.value)}
                className="h-6 w-14 rounded border border-border bg-surface-2 px-1.5 text-center font-mono text-[11.5px] text-foreground outline-none focus:border-blue"
              />
              %
            </span>
            <span className="flex items-center gap-1.5">
              트리거2
              <input
                type="number"
                min={-95}
                max={-1}
                step={5}
                value={trigger2Input}
                onChange={(e) => setTrigger2Input(e.target.value)}
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
              <span>
                · 매월 투입액 중 현금비율만큼은 보류했다가, 고점 대비 낙폭이 트리거에 닿을 때마다
                남은 현금을 나눠 투입합니다. 신고점 갱신 시 트리거가 다시 무장됩니다.
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
                      <td className="py-1.5 pr-3 text-red">{s.mddPct.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cashBufferEvents.length > 0 && (
            <div className="overflow-x-auto border-t border-border p-3">
              <div className="mb-2 text-[11px] text-muted">
                현금 투입 이력 (낙폭이 트리거에 닿을 때마다 남은 현금 풀 중 일부를 투입)
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full min-w-100 text-[11.5px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-muted">
                      <th className="py-1 pr-3 font-medium">날짜</th>
                      <th className="py-1 pr-3 font-medium">트리거</th>
                      <th className="py-1 pr-3 font-medium">당시 낙폭</th>
                      <th className="py-1 pr-3 font-medium">투입액</th>
                      <th className="py-1 pr-3 font-medium">투입 후 잔여 현금</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {cashBufferEvents.map((e, i) => (
                      <tr key={`${e.date}-${i}`} className="border-t border-[#25253f]">
                        <td className="py-1.5 pr-3 text-zinc-300">{e.date}</td>
                        <td className="py-1.5 pr-3 text-red">{(e.triggerLevel * 100).toFixed(0)}%</td>
                        <td className="py-1.5 pr-3 text-red">{(e.drawdown * 100).toFixed(1)}%</td>
                        <td className="py-1.5 pr-3 text-zinc-300">{e.deployAmount.toLocaleString()}</td>
                        <td className="py-1.5 pr-3 text-zinc-300">{e.cashPoolAfter.toLocaleString()}</td>
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
