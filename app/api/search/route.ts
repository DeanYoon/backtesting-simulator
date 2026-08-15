import { NextRequest, NextResponse } from "next/server";

const BASE_URL = "https://yahoo-finance-api-seven.vercel.app";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json([]);
  }

  const upstream = await fetch(`${BASE_URL}/search?q=${encodeURIComponent(q)}`);
  if (!upstream.ok) {
    return NextResponse.json({ error: "search failed" }, { status: upstream.status });
  }

  const data = await upstream.json();
  return NextResponse.json(data);
}
