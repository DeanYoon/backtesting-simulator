"use client";

import type { Asset } from "@/app/lib/types";

export function PortfolioComposition({
  assets,
  onWeightChange,
  onRemove,
}: {
  assets: Asset[];
  onWeightChange: (id: string, weight: number) => void;
  onRemove: (id: string) => void;
}) {
  const total = assets.reduce((sum, a) => sum + a.weight, 0);

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-300">
        <span className="h-[13px] w-[3px] rounded-sm bg-green" />
        포트폴리오 구성
      </div>

      {assets.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted">티커를 검색해서 추가하세요</p>
      ) : (
        <div className="flex flex-col">
          {assets.map((asset) => (
            <div
              key={asset.id}
              className="flex flex-col gap-1.5 border-b border-dashed border-[#25253f] py-2.5 last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: asset.color }}
                  aria-hidden
                />
                <span className="flex-1 truncate text-[13px] font-medium text-zinc-200">
                  {asset.ticker}
                </span>
                <span
                  className="font-mono text-[12.5px] font-semibold"
                  style={{ color: asset.color }}
                >
                  {asset.weight}%
                </span>
                <button
                  onClick={() => onRemove(asset.id)}
                  className="rounded bg-red px-1.5 py-0.5 text-[11px] leading-[18px] text-white hover:brightness-110"
                >
                  제거
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={asset.weight}
                onChange={(e) => onWeightChange(asset.id, Number(e.target.value))}
                style={{ color: asset.color }}
              />
            </div>
          ))}
        </div>
      )}

      <div
        className={`mt-1 border-t border-[#25253f] pt-2 font-mono text-[11.5px] ${
          total === 100 ? "font-semibold text-green" : "text-muted"
        }`}
      >
        합계 {total}%
      </div>
    </div>
  );
}
