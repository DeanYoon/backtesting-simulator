import type { SeriesPoint } from "./types";

const DAY_MS = 1000 * 60 * 60 * 24;

// Same threshold used for the growth-chart peak/trough markers, so every
// row in the drawdown table corresponds 1:1 to a red/blue dot on the chart.
export const MDD_SEGMENT_THRESHOLD = 0.05;

export type MDDSegment = {
  peakDate: string;
  peakValue: number;
  troughDate: string;
  troughValue: number;
  recoveryDate: string | null; // null = not yet recovered
  dropPct: number; // negative fraction, e.g. -0.35 for a 35% drawdown
  drawdownDays: number; // peak -> trough
  recoveryDays: number | null; // trough -> recovery
  totalDays: number | null; // peak -> recovery
};

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS);
}

// Walks the series once, tracking the running peak and the lowest point
// seen since that peak. Whenever a new all-time high confirms a prior
// decline (>= threshold), that peak/trough/recovery triple becomes a
// segment. A decline that hasn't yet recovered by the end of the data is
// still included (with recoveryDate/recoveryDays/totalDays = null) as long
// as it has stopped making new lows.
export function calcMDDSegments(
  data: SeriesPoint[],
  threshold: number = MDD_SEGMENT_THRESHOLD,
): MDDSegment[] {
  const n = data.length;
  if (n === 0) return [];

  const segments: MDDSegment[] = [];

  let runningMaxIndex = 0;
  let runningMax = data[0].value;
  let drawdownMinIndex = 0;
  let drawdownMinValue = data[0].value;

  const confirmIfSignificant = (recoveryIndex: number | null) => {
    if (drawdownMinIndex === runningMaxIndex) return;
    const dropPct = (drawdownMinValue - runningMax) / runningMax;
    if (Math.abs(dropPct) < threshold) return;

    const peakDate = data[runningMaxIndex].date;
    const troughDate = data[drawdownMinIndex].date;
    const recoveryDate = recoveryIndex !== null ? data[recoveryIndex].date : null;

    segments.push({
      peakDate,
      peakValue: runningMax,
      troughDate,
      troughValue: drawdownMinValue,
      recoveryDate,
      dropPct,
      drawdownDays: daysBetween(peakDate, troughDate),
      recoveryDays: recoveryDate ? daysBetween(troughDate, recoveryDate) : null,
      totalDays: recoveryDate ? daysBetween(peakDate, recoveryDate) : null,
    });
  };

  for (let i = 1; i < n; i++) {
    if (data[i].value > runningMax) {
      confirmIfSignificant(i);
      runningMax = data[i].value;
      runningMaxIndex = i;
      drawdownMinValue = data[i].value;
      drawdownMinIndex = i;
    } else if (data[i].value < drawdownMinValue) {
      drawdownMinValue = data[i].value;
      drawdownMinIndex = i;
    }
  }

  // Trailing, not-yet-recovered decline: still counts once it has stopped
  // making new lows before the data ends.
  if (drawdownMinIndex !== n - 1) {
    confirmIfSignificant(null);
  }

  return segments;
}
