import { NextResponse } from "next/server";
import {
  isAllowedLocalAiEndpoint,
  modelsUrl,
  normalizeOpenAiBaseUrl,
  parseModelIds,
} from "@/lib/openai-endpoint.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { baseUrl?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const baseUrl = String(body.baseUrl ?? "").trim();
  if (!isAllowedLocalAiEndpoint(baseUrl)) {
    return NextResponse.json(
      { error: "Endpoint must be on loopback, your LAN, .local, or Tailscale" },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const key = String(body.apiKey ?? "").trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(modelsUrl(baseUrl), { headers, signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return NextResponse.json({ error: `Endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}` }, { status: 502 });
    }
    const payload = await response.json();
    return NextResponse.json({
      ok: true,
      baseUrl: normalizeOpenAiBaseUrl(baseUrl),
      models: parseModelIds(payload),
    });
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError"
      ? "Connection timed out after 10 seconds"
      : err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
