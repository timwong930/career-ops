import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { runDiscovery } from "@/lib/core/scan";
import { DEFAULT_FILTERS, type DiscoveredOffer, type ExploreFilters, type ScanEvent } from "@/lib/explore";
import { chatCompletionsUrl, isAllowedLocalAiEndpoint, normalizeOpenAiBaseUrl } from "@/lib/openai-endpoint.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

type EndpointConfig = { baseUrl: string; model: string };
type SearchPlan = { positive: string[]; negative: string[]; sinceDays: number };
type Ranked = { url: string; why?: string; confidence?: "low" | "medium" | "high" };

function readEndpointConfig(): EndpointConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(careerOpsRoot(), "data", "web-ai.json"), "utf8"));
    if (raw?.mode !== "endpoint") return null;
    const baseUrl = String(raw?.endpoint?.baseUrl ?? "").trim();
    const model = String(raw?.endpoint?.model ?? "").trim();
    if (!baseUrl || !model || !isAllowedLocalAiEndpoint(baseUrl)) return null;
    return { baseUrl: normalizeOpenAiBaseUrl(baseUrl), model };
  } catch {
    return null;
  }
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
    return "";
  }).join("");
}

async function localCompletion(config: EndpointConfig, apiKey: string, prompt: string, maxTokens = 1800): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers,
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: maxTokens,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`Local AI returned HTTP ${response.status}`);
    const payload = await response.json();
    const text = messageText(payload?.choices?.[0]?.message).trim();
    if (!text) throw new Error("Local AI returned an empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function jsonSlice(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const firstObj = fenced.indexOf("{");
  const lastObj = fenced.lastIndexOf("}");
  const firstArr = fenced.indexOf("[");
  const lastArr = fenced.lastIndexOf("]");
  const candidates: string[] = [];
  if (firstObj >= 0 && lastObj > firstObj) candidates.push(fenced.slice(firstObj, lastObj + 1));
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(fenced.slice(firstArr, lastArr + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  throw new Error("Local AI did not return valid JSON");
}

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!clean || clean.length > 80 || out.some((x) => x.toLowerCase() === clean.toLowerCase())) continue;
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

async function makeSearchPlan(config: EndpointConfig, apiKey: string, query: string): Promise<SearchPlan> {
  const prompt = `Convert this job-search intent into BROAD deterministic ATS title filters.\n\nUSER INTENT:\n${query}\n\nReturn ONLY JSON with this schema:\n{"positive":["..."],"negative":["..."],"sinceDays":30}\n\nRules:\n- positive: 2-6 common substrings likely to appear literally in relevant job TITLES. Prefer recall over precision. Include adjacent titles when useful.\n- Do not put company names, locations, compensation, remote/hybrid terms, or prose in positive.\n- negative: 0-5 clearly unwanted title substrings only when the user explicitly excludes them.\n- sinceDays: 7-60. Use 30 unless the user clearly asks for a tighter freshness window.\n- Do not invent constraints.\n- JSON only.`;
  try {
    const parsed = jsonSlice(await localCompletion(config, apiKey, prompt, 700)) as Record<string, unknown>;
    const positive = strings(parsed?.positive, 6);
    const negative = strings(parsed?.negative, 5);
    const n = Number(parsed?.sinceDays);
    const sinceDays = Number.isFinite(n) ? Math.min(60, Math.max(7, Math.round(n))) : 30;
    return { positive, negative, sinceDays };
  } catch {
    return { positive: [], negative: [], sinceDays: 30 };
  }
}

function broadenKeywords(values: string[]): string[] {
  const stop = new Set(["senior", "junior", "lead", "staff", "principal", "manager", "engineer", "specialist", "remote"]);
  const out = [...values];
  for (const value of values) {
    for (const word of value.toLowerCase().split(/[^a-z0-9+#.]+/)) {
      if (word.length < 5 || stop.has(word)) continue;
      if (!out.some((x) => x.toLowerCase() === word)) out.push(word);
      if (out.length >= 8) return out;
    }
  }
  return out.slice(0, 8);
}

function scanFilters(plan: SearchPlan, broad = false): ExploreFilters {
  return {
    ...DEFAULT_FILTERS,
    ats: [...DEFAULT_FILTERS.ats],
    positive: broad ? broadenKeywords(plan.positive) : plan.positive,
    negative: plan.negative,
    // Location/company/stage constraints are applied by the local model after
    // retrieval. Keeping deterministic retrieval broad prevents false zeroes.
    allow: [],
    block: [],
    blockHard: [],
    alwaysAllow: [],
    sinceDays: broad ? Math.max(30, plan.sinceDays) : plan.sinceDays,
    limitPerAts: 200,
  };
}

async function rankOffers(config: EndpointConfig, apiKey: string, query: string, offers: DiscoveredOffer[]): Promise<Ranked[]> {
  const candidates = offers.slice(0, 80).map((o) => ({
    url: o.url,
    company: o.company,
    title: o.title,
    location: o.location,
    postedAt: o.postedAt,
    ats: o.ats,
  }));
  const prompt = `Rank real job postings for the user's intent. Every candidate below came from a live public ATS retrieval. You MUST select only exact URLs from this list; never create or modify a URL.\n\nUSER INTENT:\n${query}\n\nCANDIDATES:\n${JSON.stringify(candidates)}\n\nReturn ONLY a JSON array of up to 12 objects:\n[{"url":"exact URL from candidates","why":"one concise reason grounded only in title/company/location/date and the user intent","confidence":"high|medium|low"}]\n\nRules:\n- Prefer the strongest matches.\n- Respect explicit location/seniority/function constraints when the candidate metadata supports them.\n- If a constraint cannot be verified, lower confidence or mention the uncertainty; do not invent facts.\n- Do not include weak matches just to reach 12.\n- JSON only.`;
  try {
    const parsed = jsonSlice(await localCompletion(config, apiKey, prompt, 2200));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 12).map((row): Ranked | null => {
      if (!row || typeof row !== "object") return null;
      const rec = row as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url.trim() : "";
      if (!url) return null;
      const confidence = rec.confidence === "high" || rec.confidence === "medium" || rec.confidence === "low" ? rec.confidence : undefined;
      return { url, why: typeof rec.why === "string" ? rec.why.trim().slice(0, 220) : undefined, confidence };
    }).filter((x): x is Ranked => Boolean(x));
  } catch {
    return [];
  }
}

function envelope(offer: DiscoveredOffer, ranked?: Ranked): string {
  return `<<offer:${JSON.stringify({
    url: offer.url,
    title: offer.title,
    company: offer.company,
    location: offer.location,
    postedAt: offer.postedAt,
    source: "ai-local-scan",
    why: ranked?.why || "Matched the local-AI search plan and was retrieved from a public ATS.",
    ats: offer.ats,
    confidence: ranked?.confidence || "medium",
  })}>>\n`;
}

export async function POST(req: Request) {
  let body: { query?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const query = String(body.query ?? "").trim();
  if (!query) return Response.json({ error: "query required" }, { status: 400 });
  const config = readEndpointConfig();
  if (!config) return Response.json({ error: "No local AI endpoint is configured — open Settings → AI Engine" }, { status: 400 });
  const apiKey = String(body.apiKey ?? "").trim();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try { controller.enqueue(encoder.encode(text)); } catch { /* client closed */ }
      };
      try {
        send(`Using ${config.model} to turn your intent into broad ATS search filters…\n`);
        const plan = await makeSearchPlan(config, apiKey, query);
        send(`Searching Greenhouse, Lever, Ashby, and Workday with ${plan.positive.length ? plan.positive.join(", ") : "broad title recall"}…\n`);

        const progress = (e: ScanEvent) => {
          if (e.kind === "atsStart") send(`Scanning ${e.ats} (${e.companies} sampled companies)…\n`);
        };
        let offers = await runDiscovery(scanFilters(plan), progress);
        if (offers.length === 0 && plan.positive.length > 0) {
          send("No matches in the first sample; widening the title terms and date window once…\n");
          offers = await runDiscovery(scanFilters(plan, true), progress);
        }

        if (offers.length === 0) {
          send("No retrievable ATS postings matched this search. Try broader role wording or the free Scan controls.\n");
          controller.close();
          return;
        }

        send(`Found ${offers.length} ATS candidate${offers.length === 1 ? "" : "s"}; ${config.model} is ranking the strongest matches…\n`);
        const ranked = await rankOffers(config, apiKey, query, offers);
        const byUrl = new Map(offers.map((o) => [o.url, o]));
        const selected: Array<{ offer: DiscoveredOffer; ranked?: Ranked }> = [];
        const seen = new Set<string>();
        for (const item of ranked) {
          const offer = byUrl.get(item.url);
          if (!offer || seen.has(offer.url)) continue;
          seen.add(offer.url);
          selected.push({ offer, ranked: item });
        }
        if (selected.length === 0) {
          for (const offer of offers.slice(0, 12)) selected.push({ offer });
        }
        for (const item of selected.slice(0, 12)) send(envelope(item.offer, item.ranked));
      } catch (err) {
        send(`Local AI search failed: ${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
