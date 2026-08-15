"use client";

import { useEffect, useRef, useState } from "react";
import { searchTicker, type SearchResult } from "@/app/lib/api";

export function TickerSearch({ onAdd }: { onAdd: (ticker: string) => void }) {
  const [value, setValue] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const query = value.trim();
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const data = await searchTicker(query);
        if (id === requestId.current) {
          setResults(data.slice(0, 8));
          setOpen(true);
        }
      } catch {
        if (id === requestId.current) setResults([]);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  function reset() {
    setValue("");
    setResults([]);
    setOpen(false);
  }

  function handleSelect(symbol: string) {
    onAdd(symbol.toUpperCase());
    reset();
  }

  function handleAddRaw() {
    const ticker = value.trim().toUpperCase();
    if (!ticker) return;
    onAdd(ticker);
    reset();
  }

  return (
    <div className="relative rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-300">
        <span className="h-[13px] w-[3px] rounded-sm bg-blue" />
        티커 검색
      </div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (results.length > 0) handleSelect(results[0].symbol);
              else handleAddRaw();
            }
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="티커 또는 회사명 검색 (예: AAPL, Apple)"
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-3 text-[13px] text-foreground outline-none placeholder:text-zinc-600 focus:border-blue"
        />
        <button
          onClick={handleAddRaw}
          className="h-9 shrink-0 rounded-md bg-purple px-4 text-xs font-medium text-white hover:brightness-110"
        >
          추가
        </button>
      </div>

      {open && (
        <div className="absolute left-3 right-3 top-[62px] z-10 max-h-64 overflow-y-auto rounded-md border border-border bg-surface-2 shadow-lg">
          {loading && <div className="px-3 py-2 text-[11px] text-muted">검색 중...</div>}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted">검색 결과 없음</div>
          )}
          {!loading &&
            results.map((r) => (
              <button
                key={r.symbol}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(r.symbol)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-[#22223e]"
              >
                <span className="shrink-0 font-mono font-semibold text-zinc-100">
                  {r.symbol}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-400">
                  {r.shortname ?? r.longname ?? ""}
                </span>
                <span className="shrink-0 text-[10.5px] text-muted-2">
                  {r.exchDisp ?? r.exchange}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
