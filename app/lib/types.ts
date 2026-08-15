export type Asset = {
  id: string;
  ticker: string;
  weight: number;
  color: string;
};

export type SeriesPoint = {
  date: string;
  value: number;
};
