"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_FILTERS,
  ATS_LABEL,
  filtersToParams,
  aiToParams,
  isBroadSearch,
  parseExplorePatch,
  type AtsSource,
  type DiscoveredOffer,
  type ExploreFilters,
  type ExploreMode,
  type ScanEvent,
} from "@/lib/explore";
import { makeAiStreamParser, type AiTraceChunk } from "@/lib/explore-ai";
import { isScannerMissing } from "@/lib/explore-error.mjs";

export type Phase =
  | "idle"
  | "casting"
  | "scanning"
  | "revealing"
  | "results"
  | "empty-current"
  | "empty-loose"
  | "failed"
  | "degraded"
  | "hunting"
  | "blocked";

export type AiCost = { searches: number; candidates: number; fetches: number };
export type SourceState = {
  state: "queued" | "active" | "swept" | "noisy";
  companies?: number;
  done?: number;
  total?: number;
  matches?: number;
  unreachable?: number;
};

type AiProvider = {
  mode: "cli" | "endpoint" | "none";
  cliId?: string;
  name?: string;
};

type ExploreCtx = {
  filters: ExploreFilters;
  setFilters: (f: ExploreFilters) => void;
  initFilters: (f: ExploreFilters) => void;
  phase: Phase;
  running: boolean;
  offers: DiscoveredOffer[];
  sources: Partial<Record<AtsSource, SourceState>>;
  matchCount: number;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  status: string;
  partial: boolean;
  error: string;
  scannerMissing: boolean;
  added: Set<string>;
  adding: Set<string>;
  discover: () => Promise<void>;
  loadFresh: () => Promise<void>;
  addToPipeline: (offers: DiscoveredOffer[]) => Promise<number>;
  applyPatch: (raw: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => void;
  reset: () => void;
  mode: ExploreMode;
  setMode: (m: ExploreMode) => void;
  aiIntent: string;
  setAiIntent: (s: string) => void;
  discoverAI: () => Promise<void>;
  aiTrace: AiTraceChunk[];
  aiCost: AiCost;
  aiProviderName?: string;
  aiProviderMode: AiProvider["mode"];
};

const Ctx = createContext<ExploreCtx | null>(null);
export function useExplore(): ExploreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useExplore must be used within <ExploreProvider>");
  return c;
}

const RESULTS_KEY = "career-ops:explore-results";
const CLI_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  copilot: "Copilot CLI",
  qwen: "Qwen CLI",
  antigravity: "Antigravity CLI",
  grok: "Grok Build CLI",
};

type ResultSnapshot = {
  v: number;
  mode: ExploreMode;
  phase: Phase;
  offers: DiscoveredOffer[];
  matchCount: number;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  sources: Partial<Record<AtsSource, SourceState>>;
  partial: boolean;
  status: string;
  error: string;
  scannerMissing: boolean;
  added: string[];
  aiTrace: AiTraceChunk[];
  aiCost: AiCost;
  aiIntent: string;
};

async function readServerAiProvider(): Promise<AiProvider> {
  try {
    const response = await fetch("/api/ai/config", { cache: "no-store" });
    const data = await response.json();
    const config = data?.config;
    if (config?.mode === "endpoint" && config?.endpoint?.model) {
      return { mode: "endpoint", name: String(config.endpoint.model) };
    }
    if (config?.mode === "cli" && config?.cliId) {
      const cliId = String(config.cliId);
      return { mode: "cli", cliId, name: CLI_NAMES[cliId] || cliId };
    }
  } catch {
    /* fall through to old browser preference for backwards compatibility */
  }

  try {
    const cliId = JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId || null;
    if (cliId) return { mode: "cli", cliId, name: CLI_NAMES[cliId] || cliId };
  } catch {
    /* ignore */
  }
  return { mode: "none" };
}

function endpointApiKey(): string {
  try {
    return sessionStorage.getItem("career-ops:endpoint-api-key") || "";
  } catch {
    return "";
  }
}

export function ExploreProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [filters, setFiltersState] = useState<ExploreFilters>({ ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats] });
  const touched = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [offers, setOffers] = useState<DiscoveredOffer[]>([]);
  const [sources, setSources] = useState<Partial<Record<AtsSource, SourceState>>>({});
  const [matchCount, setMatchCount] = useState(0);
  const [companiesScanned, setCompaniesScanned] = useState(0);
  const [companiesAvailable, setCompaniesAvailable] = useState(0);
  const [capHit, setCapHit] = useState(false);
  const [droppedNoDate, setDroppedNoDate] = useState(0);
  const [status, setStatus] = useState("");
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState("");
  const [scannerMissing, setScannerMissing] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [mode, setModeState] = useState<ExploreMode>("scan");
  const [aiIntent, setAiIntent] = useState("");
  const [aiTrace, setAiTrace] = useState<AiTraceChunk[]>([]);
  const [aiCost, setAiCost] = useState<AiCost>({ searches: 0, candidates: 0, fetches: 0 });
  const [aiProvider, setAiProvider] = useState<AiProvider>({ mode: "none" });
  const runningRef = useRef(false);
  const aiIntentRef = useRef(aiIntent);
  aiIntentRef.current = aiIntent;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    void readServerAiProvider().then(setAiProvider);
  }, []);

  const setFilters = useCallback((f: ExploreFilters) => {
    touched.current = true;
    filtersRef.current = f;
    setFiltersState(f);
  }, []);

  const initFilters = useCallback((f: ExploreFilters) => {
    if (touched.current) return;
    filtersRef.current = f;
    setFiltersState(f);
  }, []);

  const discover = useCallback(async () => {
    if (runningRef.current) return;
    const f = filtersRef.current;
    runningRef.current = true;
    setPhase("casting");
    setOffers([]);
    setMatchCount(0);
    setCompaniesScanned(0);
    setCompaniesAvailable(0);
    setCapHit(false);
    setDroppedNoDate(0);
    setPartial(false);
    setError("");
    setScannerMissing(false);
    setStatus("Casting the net across the ATS network…");
    const init: Partial<Record<AtsSource, SourceState>> = {};
    for (const a of f.ats) init[a] = { state: "queued" };
    setSources(init);
    if (typeof window !== "undefined") {
      const qs = filtersToParams(f);
      window.history.replaceState(null, "", `/explore${qs ? `?${qs}` : ""}`);
    }

    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let sawScannerMissing = false;
    let companiesScannedAcc = 0;
    let capHitAcc = false;
    let datasetIssueAcc = false;
    let droppedNoDateAcc = 0;

    try {
      const r = await fetch("/api/explore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        sawScannerMissing = isScannerMissing(d);
        sawError = d.error || (sawScannerMissing ? "The scanner isn't available." : `Discovery failed (${r.status}).`);
      } else if (!r.body) {
        sawError = "No response stream.";
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: ScanEvent;
            try { ev = JSON.parse(line) as ScanEvent; } catch { continue; }
            switch (ev.kind) {
              case "atsStart":
                setPhase("scanning");
                setStatus(`Walking ${ATS_LABEL[ev.ats as AtsSource] ?? ev.ats} — ${ev.companies.toLocaleString()} companies`);
                setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: "active", companies: ev.companies } }));
                break;
              case "progress":
                setMatchCount((m) => Math.max(m, ev.matches));
                setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: "active", done: ev.scanned, total: ev.total } }));
                break;
              case "atsDone":
                setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: ev.unreachable > 0 ? "noisy" : "swept", unreachable: ev.unreachable } }));
                break;
              case "offer":
                acc.push(ev.offer);
                setOffers((o) => [...o, ev.offer]);
                break;
              case "summary": {
                companiesScannedAcc = ev.companiesScanned;
                setCompaniesScanned(ev.companiesScanned);
                if (typeof ev.companiesAvailable === "number") setCompaniesAvailable(ev.companiesAvailable);
                if (ev.capHit) {
                  capHitAcc = true;
                  setCapHit(true);
                }
                const datasetIssue = ev.datasetStatus ? Object.values(ev.datasetStatus).some((s) => s !== "ok") : false;
                if (datasetIssue) datasetIssueAcc = true;
                if (typeof ev.postingsDroppedNoDate === "number" && ev.postingsDroppedNoDate > 0) {
                  droppedNoDateAcc = ev.postingsDroppedNoDate;
                  setDroppedNoDate(ev.postingsDroppedNoDate);
                }
                if (ev.unreachable > 0 || datasetIssue) setPartial(true);
                break;
              }
              case "error":
                sawError = ev.message;
                break;
              default:
                break;
            }
          }
        }
      }
    } catch (e) {
      sawError = e instanceof Error ? e.message : "stream error";
    }

    setSources((s) => {
      const next = { ...s };
      for (const k of Object.keys(next) as AtsSource[]) {
        if (next[k]?.state === "active" || next[k]?.state === "queued") next[k] = { ...next[k]!, state: "swept" };
      }
      return next;
    });

    runningRef.current = false;
    if (acc.length > 0) {
      setMatchCount(acc.length);
      setPhase("revealing");
      setStatus(`${acc.length} fresh role${acc.length === 1 ? "" : "s"} found — free.`);
      window.setTimeout(() => setPhase("results"), 850);
    } else if (sawError) {
      setError(sawError);
      setScannerMissing(sawScannerMissing);
      setPhase("failed");
    } else if (capHitAcc || datasetIssueAcc || droppedNoDateAcc > 0 || companiesScannedAcc === 0) {
      setPhase("degraded");
    } else {
      setPhase(isBroadSearch(f) ? "empty-current" : "empty-loose");
    }
  }, []);

  const loadFresh = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("casting");
    setStatus("Loading fresh matches…");
    setOffers([]);
    setMatchCount(0);
    setCompaniesScanned(0);
    setCompaniesAvailable(0);
    setCapHit(false);
    setDroppedNoDate(0);
    setPartial(false);
    setSources({});
    setError("");
    try {
      const r = await fetch("/api/whats-new");
      if (!r.ok) {
        setError(`Couldn't load fresh matches (${r.status}).`);
        setPhase("failed");
        return;
      }
      const d = await r.json().catch(() => null);
      if (!d || !Array.isArray(d.offers)) {
        setError("Couldn't load fresh matches — unexpected response.");
        setPhase("failed");
        return;
      }
      const list: DiscoveredOffer[] = d.offers;
      setOffers(list);
      setMatchCount(list.length);
      setPhase(list.length > 0 ? "results" : "empty-current");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load fresh matches.");
      setPhase("failed");
    } finally {
      runningRef.current = false;
    }
  }, []);

  const addToPipeline = useCallback(async (list: DiscoveredOffer[]) => {
    const fresh = list.filter((o) => !added.has(o.url));
    if (fresh.length === 0) return 0;
    setAdding((s) => new Set([...s, ...fresh.map((o) => o.url)]));
    try {
      const r = await fetch("/api/explore/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offers: fresh }),
      });
      const d = (await r.json()) as { added?: number };
      if (d.added && d.added > 0) {
        setAdded((s) => new Set([...s, ...fresh.map((o) => o.url)]));
        router.refresh();
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: "explore-add" } }));
      }
      return d.added ?? 0;
    } catch {
      return 0;
    } finally {
      setAdding((s) => {
        const next = new Set(s);
        for (const o of fresh) next.delete(o.url);
        return next;
      });
    }
  }, [added, router]);

  const applyPatch = useCallback((raw: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => {
    const next = parseExplorePatch(raw, filtersRef.current, opts?.merge ?? false);
    setFilters(next);
    filtersRef.current = next;
    if (opts?.run) void discover();
  }, [discover, setFilters]);

  const reset = useCallback(() => {
    runningRef.current = false;
    setPhase("idle");
    setOffers([]);
    setSources({});
    setMatchCount(0);
    setCompaniesScanned(0);
    setCompaniesAvailable(0);
    setCapHit(false);
    setDroppedNoDate(0);
    setStatus("");
    setPartial(false);
    setError("");
    setScannerMissing(false);
    setAiTrace([]);
    setAiCost({ searches: 0, candidates: 0, fetches: 0 });
    try { sessionStorage.removeItem(RESULTS_KEY); } catch { /* ignore */ }
  }, []);

  const discoverAI = useCallback(async () => {
    if (runningRef.current) return;
    const intent = aiIntentRef.current.trim();
    if (!intent) return;

    const provider = await readServerAiProvider();
    setAiProvider(provider);
    if (provider.mode === "none") {
      setPhase("blocked");
      return;
    }

    runningRef.current = true;
    setPhase("casting");
    setOffers([]);
    setMatchCount(0);
    setAiTrace([]);
    setAiCost({ searches: 0, candidates: 0, fetches: 0 });
    setError("");
    setScannerMissing(false);
    setStatus(provider.mode === "endpoint" ? "Using local AI with public ATS retrieval…" : "Casting across the open web…");
    if (typeof window !== "undefined") window.history.replaceState(null, "", `/explore?${aiToParams(intent)}`);

    let knownUrls = new Set<string>();
    try {
      const k = await fetch("/api/explore/ai/known").then((r) => r.json());
      knownUrls = new Set<string>(Array.isArray(k.urls) ? k.urls : []);
    } catch {
      /* best-effort dedup */
    }
    const parser = makeAiStreamParser({ knownUrls });
    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let sawScannerMissing = false;

    const handle = (chunks: AiTraceChunk[]) => {
      for (const ch of chunks) {
        if (ch.kind === "offer") {
          acc.push(ch.offer);
          setOffers((o) => [...o, ch.offer]);
          setMatchCount(acc.length);
          setAiCost((c) => ({ ...c, candidates: acc.length }));
          setPhase("hunting");
        } else {
          setAiTrace((t) => [...t, ch]);
          if (ch.kind === "narration") {
            const s = (ch.text.match(/\bsearch(ing|ed)?\b/gi) || []).length;
            const f = (ch.text.match(/\bfetch(ing|ed)?\b/gi) || []).length;
            if (s || f) setAiCost((c) => ({ ...c, searches: c.searches + s, fetches: c.fetches + f }));
            setPhase((p) => (p === "casting" ? "hunting" : p));
          }
        }
      }
    };

    try {
      const endpointMode = provider.mode === "endpoint";
      const r = await fetch(endpointMode ? "/api/explore/ai/endpoint" : "/api/explore/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          endpointMode
            ? { query: intent, apiKey: endpointApiKey() }
            : { query: intent, cliId: provider.cliId },
        ),
      });
      if (r.status === 404 && provider.mode === "cli") {
        runningRef.current = false;
        setPhase("blocked");
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        sawScannerMissing = isScannerMissing(d);
        sawError = d.error || (sawScannerMissing ? "AI search isn't available." : `AI search failed (${r.status}).`);
      } else if (!r.body) {
        sawError = "No response stream.";
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          handle(parser.feed(dec.decode(value, { stream: true })));
        }
        handle(parser.flush());
      }
    } catch (e) {
      sawError = e instanceof Error ? e.message : "stream error";
    }

    runningRef.current = false;
    if (acc.length > 0) {
      setMatchCount(acc.length);
      setPhase("revealing");
      setStatus(`${acc.length} candidate${acc.length === 1 ? "" : "s"} found.`);
      window.setTimeout(() => setPhase("results"), 850);
    } else if (sawError) {
      setError(sawError);
      setScannerMissing(sawScannerMissing);
      setPhase("failed");
    } else {
      setPhase("empty-loose");
    }
  }, []);

  const setMode = useCallback((m: ExploreMode) => {
    runningRef.current = false;
    setModeState(m);
    if (m === "ai") void readServerAiProvider().then(setAiProvider);
  }, []);

  useEffect(() => {
    if (runningRef.current) return;
    let snap: ResultSnapshot | null = null;
    try { snap = JSON.parse(sessionStorage.getItem(RESULTS_KEY) || "null") as ResultSnapshot | null; } catch { snap = null; }
    if (!snap || snap.v !== 1 || !Array.isArray(snap.offers)) return;
    setModeState(snap.mode === "ai" ? "ai" : "scan");
    setOffers(snap.offers);
    setMatchCount(typeof snap.matchCount === "number" ? snap.matchCount : snap.offers.length);
    setCompaniesScanned(snap.companiesScanned ?? 0);
    setCompaniesAvailable(snap.companiesAvailable ?? 0);
    setCapHit(!!snap.capHit);
    setDroppedNoDate(snap.droppedNoDate ?? 0);
    setSources(snap.sources ?? {});
    setPartial(!!snap.partial);
    setStatus(typeof snap.status === "string" ? snap.status : "");
    setError(typeof snap.error === "string" ? snap.error : "");
    setScannerMissing(!!snap.scannerMissing);
    setAdded(new Set(Array.isArray(snap.added) ? snap.added : []));
    setAiTrace(Array.isArray(snap.aiTrace) ? snap.aiTrace : []);
    setAiCost(snap.aiCost ?? { searches: 0, candidates: 0, fetches: 0 });
    if (typeof snap.aiIntent === "string") setAiIntent(snap.aiIntent);
    const RUNNING = new Set<Phase>(["casting", "scanning", "revealing", "hunting"]);
    setPhase(RUNNING.has(snap.phase) ? (snap.offers.length ? "results" : "idle") : snap.phase);
  }, []);

  useEffect(() => {
    const SETTLED = new Set<Phase>(["results", "empty-current", "empty-loose", "failed", "degraded", "blocked"]);
    if (!SETTLED.has(phase)) return;
    try {
      const snap: ResultSnapshot = {
        v: 1,
        mode,
        phase,
        offers,
        matchCount,
        companiesScanned,
        companiesAvailable,
        capHit,
        droppedNoDate,
        sources,
        partial,
        status,
        error,
        scannerMissing,
        added: [...added],
        aiTrace,
        aiCost,
        aiIntent,
      };
      sessionStorage.setItem(RESULTS_KEY, JSON.stringify(snap));
    } catch {
      /* sessionStorage full/unavailable */
    }
  }, [phase, mode, offers, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, sources, partial, status, error, scannerMissing, added, aiTrace, aiCost, aiIntent]);

  const value = useMemo(
    () => ({
      filters,
      setFilters,
      initFilters,
      phase,
      running: phase === "casting" || phase === "scanning" || phase === "revealing" || phase === "hunting",
      offers,
      sources,
      matchCount,
      companiesScanned,
      companiesAvailable,
      capHit,
      droppedNoDate,
      status,
      partial,
      error,
      scannerMissing,
      added,
      adding,
      discover,
      loadFresh,
      addToPipeline,
      applyPatch,
      reset,
      mode,
      setMode,
      aiIntent,
      setAiIntent,
      discoverAI,
      aiTrace,
      aiCost,
      aiProviderName: aiProvider.name,
      aiProviderMode: aiProvider.mode,
    }),
    [filters, setFilters, initFilters, phase, offers, sources, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, status, partial, error, scannerMissing, added, adding, discover, loadFresh, addToPipeline, applyPatch, reset, mode, setMode, aiIntent, discoverAI, aiTrace, aiCost, aiProvider],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
