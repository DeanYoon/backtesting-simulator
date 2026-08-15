import { NextRequest, NextResponse } from "next/server";

const BASE_URL = "https://yahoo-finance-api-seven.vercel.app";

export async function GET(request: NextRequest) {
  const symbols = request.nextUrl.searchParams.get("symbols")?.trim();
  const period = request.nextUrl.searchParams.get("period") ?? "5y";
  const interval = request.nextUrl.searchParams.get("interval");

  if (!symbols) {
    return NextResponse.json({ error: "symbols is required" }, { status: 400 });
  }

  const url = new URL(`${BASE_URL}/history`);
  url.searchParams.set("symbols", symbols);
  url.searchParams.set("period", period);
  if (interval) url.searchParams.set("interval", interval);

  const upstream = await fetch(url);
  if (!upstream.ok) {
    return NextResponse.json({ error: "history fetch failed" }, { status: upstream.status });
  }

  const data = await upstream.json();
  return NextResponse.json(data);
}
