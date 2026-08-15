"use client";

export type Period = "5y" | "10y" | "max";

const OPTIONS: { value: Period; label: string }[] = [
  { value: "5y", label: "5년" },
  { value: "10y", label: "10년" },
  { value: "max", label: "20년+ (전체)" },
];

export function PeriodSelector({
  value,
  onChange,
}: {
  value: Period;
  onChange: (period: Period) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-300">
        <span className="h-[13px] w-[3px] rounded-sm bg-purple" />
        조회 기간
      </div>
      <div className="flex gap-2">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`h-8 flex-1 rounded-md text-[12px] font-medium transition ${
              value === opt.value
                ? "bg-blue text-white"
                : "bg-surface-2 text-muted hover:text-zinc-200"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
