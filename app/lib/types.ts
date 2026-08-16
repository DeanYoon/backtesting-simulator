export type Currency = "USD" | "KRW" | "JPY";

export type Asset = {
  id: string;
  ticker: string;
  weight: number;
  color: string;
  // Currency the asset's raw price data is denominated in. Defaults to USD
  // for anything fetched through the ticker search (Yahoo Finance US-centric
  // symbols); locally-bundled funds carry their own explicit currency.
  currency: Currency;
};

export type SeriesPoint = {
  date: string;
  value: number;
};
