export type SearchResult = {
  symbol: string;
  shortname?: string;
  longname?: string;
  exchange: string;
  exchDisp?: string;
  quoteType: string;
};

export type HistoryPoint = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type HistoryResponse = Record<string, HistoryPoint[]>;

export async function searchTicker(query: string): Promise<SearchResult[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error("검색에 실패했습니다");
  return res.json();
}

export async function fetchHistory(
  symbols: string[],
  period = "1y",
): Promise<HistoryResponse> {
  const res = await fetch(
    `/api/history?symbols=${encodeURIComponent(symbols.join(","))}&period=${encodeURIComponent(period)}`,
  );
  if (!res.ok) throw new Error("주가 데이터를 가져오지 못했습니다");
  return res.json();
}
