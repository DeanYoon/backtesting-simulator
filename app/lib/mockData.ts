import type { SeriesPoint } from "./types";

// Placeholder line shown before the user runs a real analysis.
export function generateExampleSeries(): SeriesPoint[] {
  const start = new Date(2022, 0, 1);
  let value = 10000;
  const points: SeriesPoint[] = [];

  for (let i = 0; i < 36; i++) {
    const date = new Date(start);
    date.setMonth(start.getMonth() + i);
    const drift = 0.006;
    const wave = (Math.sin(i * 1.7) + Math.sin(i * 0.6)) * 0.015;
    value = value * (1 + drift + wave);
    points.push({ date: date.toISOString().slice(0, 10), value: Math.round(value) });
  }

  return points;
}
