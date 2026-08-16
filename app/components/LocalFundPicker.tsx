"use client";

import { LOCAL_FUND_TICKERS } from "@/app/data/localFunds";

export function LocalFundPicker({ onAdd }: { onAdd: (ticker: string) => void }) {
  if (LOCAL_FUND_TICKERS.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-300">
        <span className="h-[13px] w-[3px] rounded-sm bg-purple" />
        오프라인 펀드 데이터 추가
      </div>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
          e.target.value = "";
        }}
        className="h-9 w-full rounded-md border border-border bg-surface-2 px-3 text-[13px] text-foreground outline-none focus:border-blue"
      >
        <option value="" disabled>
          펀드를 선택하세요
        </option>
        {LOCAL_FUND_TICKERS.map((ticker) => (
          <option key={ticker} value={ticker}>
            {ticker}
          </option>
        ))}
      </select>
    </div>
  );
}
