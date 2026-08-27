"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  CircleDashed,
  ExternalLink,
  Loader2,
  RefreshCw,
  Server,
  Terminal,
  TerminalSquare,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { CadenceSettings } from "@/components/followups/cadence-settings";
import { persistCliId, readSavedCliId } from "@/lib/saved-cli";

type Cli = {
  id: string;
  name: string;
  run: string;
  url: string;
  installed: boolean;
  path: string | null;
};

type Mode = "cli" | "endpoint" | "manual";
type EndpointState = "idle" | "testing" | "ok" | "error";

const STORAGE_KEY = "career-ops:config";
const ENDPOINT_KEY_SESSION = "career-ops:endpoint-api-key";
const OMLX_DEFAULT = "http://127.0.0.1:8000/v1";

export function ConfigForm() {
  const [mode, setMode] = useState<Mode>("cli");
  const [clis, setClis] = useState<Cli[] | null>(null);
  const [cliId, setCliId] = useState<string>("");
  const [logos, setLogos] = useState(true);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [endpointUrl, setEndpointUrl] = useState(OMLX_DEFAULT);
  const [endpointModel, setEndpointModel] = useState("");
  const [endpointKey, setEndpointKey] = useState("");
  const [endpointModels, setEndpointModels] = useState<string[]>([]);
  const [endpointState, setEndpointState] = useState<EndpointState>("idle");
  const [endpointMessage, setEndpointMessage] = useState("");

  // Browser-local appearance + backwards-compatible CLI preference.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (v.cliId) setCliId(v.cliId);
        if (typeof v.logos === "boolean") setLogos(v.logos);
      }
      setEndpointKey(sessionStorage.getItem(ENDPOINT_KEY_SESSION) || "");
    } catch {
      /* ignore */
    }
  }, []);

  // AI engine selection is server-persistent so every LAN/Tailscale client sees
  // the same Mac Studio configuration instead of keeping its own browser copy.
  useEffect(() => {
    fetch("/api/ai/config", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const config = d?.config;
        if (config?.mode === "endpoint") {
          setMode("endpoint");
          if (config.endpoint?.baseUrl) setEndpointUrl(config.endpoint.baseUrl);
          if (config.endpoint?.model) setEndpointModel(config.endpoint.model);
        } else {
          setMode("cli");
          if (config?.cliId) setCliId(config.cliId);
        }
      })
      .catch(() => {});
  }, []);

  // Detect installed CLIs on the server (the headless Mac Studio).
  useEffect(() => {
    fetch("/api/clis")
      .then((r) => r.json())
      .then((d) => {
        const list: Cli[] = d.clis ?? [];
        setClis(list);
        setCliId((prev) => {
          if (prev) return prev;
          const only = list.filter((c) => c.installed);
          if (only.length !== 1) return list.find((c) => c.installed)?.id || "";
          if (!readSavedCliId()) persistCliId(only[0].id);
          return only[0].id;
        });
      })
      .catch(() => setClis([]));
  }, []);

  async function testEndpoint() {
    setEndpointState("testing");
    setEndpointMessage("Connecting…");
    setEndpointModels([]);
    try {
      const response = await fetch("/api/ai/endpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: endpointUrl, apiKey: endpointKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not connect");
      const models = Array.isArray(data.models) ? data.models : [];
      setEndpointModels(models);
      if (!endpointModel && models.length > 0) setEndpointModel(models[0]);
      setEndpointState("ok");
      setEndpointMessage(models.length > 0 ? `Connected · ${models.length} model${models.length === 1 ? "" : "s"} found` : "Connected · no models returned by /v1/models");
    } catch (err) {
      setEndpointState("error");
      setEndpointMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function save() {
    setSaveError("");
    if (mode === "endpoint" && (!endpointUrl.trim() || !endpointModel.trim())) {
      setSaveError("Enter an endpoint and choose/type a model first.");
      return;
    }
    setSaving(true);
    try {
      const body = mode === "endpoint"
        ? { mode, endpoint: { baseUrl: endpointUrl.trim(), model: endpointModel.trim() } }
        : { mode: "cli", cliId };
      const response = await fetch("/api/ai/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save AI configuration");

      // Keep old browser readers compatible while the server file is authoritative.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, cliId, logos }));
      if (mode === "cli" && cliId) persistCliId(cliId);
      if (mode === "endpoint") {
        if (endpointKey) sessionStorage.setItem(ENDPOINT_KEY_SESSION, endpointKey);
        else sessionStorage.removeItem(ENDPOINT_KEY_SESSION);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const installed = clis?.filter((c) => c.installed) ?? [];

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Settings</h1>
      <p className="mt-1 text-sm text-muted">
        Choose the AI that runs Career-Ops on your Mac Studio. This setting is shared by devices that connect to this server.
      </p>

      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        AI Engine
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <ModeCard
          active={mode === "cli"}
          onClick={() => setMode("cli")}
          icon={Terminal}
          title="Agent CLI"
          hint="Codex, Claude, Qwen…"
        />
        <ModeCard
          active={mode === "endpoint"}
          onClick={() => setMode("endpoint")}
          icon={Server}
          title="Local / custom endpoint"
          hint="oMLX · OpenAI-compatible"
        />
        <ModeCard
          active={mode === "manual"}
          onClick={() => setMode("manual")}
          icon={TerminalSquare}
          title="Hosted key"
          hint="Coming later"
          disabled
        />
      </div>

      <div className="mt-6">
        {mode === "cli" && (
          <div>
            <p className="mb-1 text-sm text-muted">
              Career-Ops launches an AI command-line tool installed and authenticated on this Mac.
            </p>
            <p className="mb-3 text-xs text-faint">Best for tool-heavy workflows such as CV generation and agentic actions.</p>
            {clis === null ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> Checking the Mac Studio…
              </div>
            ) : installed.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
                No supported CLI found. You can use the local endpoint mode without installing one, or install an agent CLI.{" "}
                <a href="https://career-ops.org/docs/free-ai-engine" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">
                  CLI options <ExternalLink className="size-3" />
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                {clis.map((c) => {
                  const selected = c.id === cliId;
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors",
                        selected
                          ? "border-brand/50 bg-brand-soft"
                          : c.installed
                            ? "border-border bg-surface/50"
                            : "border-border/60 bg-surface/20",
                      )}
                    >
                      {c.installed ? <Check className="size-4 shrink-0 text-emerald-400" /> : <CircleDashed className="size-4 shrink-0 text-faint" />}
                      <button
                        type="button"
                        disabled={!c.installed}
                        onClick={() => setCliId(c.id)}
                        className={cn("flex flex-1 items-center gap-2 text-left max-sm:min-h-[44px]", c.installed ? "" : "cursor-default")}
                      >
                        <span className={cn("font-medium", selected ? "text-foreground" : c.installed ? "" : "text-muted")}>{c.name}</span>
                        <span className="font-mono text-xs text-faint">{c.run}</span>
                      </button>
                      {c.installed ? (
                        <span className="hidden max-w-[40%] shrink-0 truncate text-xs text-faint sm:block">{c.path}</span>
                      ) : (
                        <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center justify-center gap-1 text-xs text-brand hover:underline max-sm:min-h-[44px]">
                          Install <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  );
                })}
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  Claude Code and Codex expose the richest live worker progress. Other supported CLIs use the same Career-Ops prompts with reduced integration.
                </p>
              </div>
            )}
          </div>
        )}

        {mode === "endpoint" && (
          <div className="space-y-5">
            <div className="rounded-xl border border-brand/20 bg-brand-soft/40 p-4">
              <div className="flex items-start gap-3">
                <Server className="mt-0.5 size-5 shrink-0 text-brand" />
                <div>
                  <p className="text-sm font-medium text-foreground">OpenAI-compatible local inference</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Designed for oMLX on this Mac Studio, but it also works with compatible servers on your LAN or tailnet. Job evaluation runs directly against the selected model; Career-Ops itself handles the trusted file writes.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Base URL</label>
                <button
                  type="button"
                  onClick={() => { setEndpointUrl(OMLX_DEFAULT); setEndpointState("idle"); setEndpointMessage(""); }}
                  className="text-xs text-brand hover:underline"
                >
                  Use oMLX default
                </button>
              </div>
              <input
                value={endpointUrl}
                onChange={(e) => { setEndpointUrl(e.target.value); setEndpointState("idle"); }}
                placeholder="http://127.0.0.1:8000/v1"
                spellCheck={false}
                className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
              />
              <p className="mt-1.5 text-xs text-faint">Allowed: localhost, private LAN, .local, and Tailscale addresses. A bare server URL automatically uses /v1.</p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">API key <span className="font-normal normal-case tracking-normal text-faint">optional</span></label>
              <input
                type="password"
                value={endpointKey}
                onChange={(e) => setEndpointKey(e.target.value)}
                placeholder="Leave blank for oMLX without auth"
                autoComplete="off"
                className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
              />
              <p className="mt-1.5 text-xs text-faint">Never written to disk. If supplied, the key stays only in this browser tab/session.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={testEndpoint}
                disabled={endpointState === "testing" || !endpointUrl.trim()}
                className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-full border border-border bg-surface/60 px-4 py-2 text-sm font-medium transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50"
              >
                {endpointState === "testing" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Test connection & load models
              </button>
              {endpointMessage && (
                <span className={cn("inline-flex items-center gap-1.5 text-xs", endpointState === "ok" ? "text-emerald-400" : endpointState === "error" ? "text-red-400" : "text-faint") }>
                  {endpointState === "ok" ? <Check className="size-3.5" /> : endpointState === "error" ? <AlertCircle className="size-3.5" /> : null}
                  {endpointMessage}
                </span>
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Model</label>
              {endpointModels.length > 0 ? (
                <select
                  value={endpointModel}
                  onChange={(e) => setEndpointModel(e.target.value)}
                  className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors focus:border-brand/50"
                >
                  {!endpointModels.includes(endpointModel) && endpointModel && <option value={endpointModel}>{endpointModel}</option>}
                  {endpointModels.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              ) : (
                <input
                  value={endpointModel}
                  onChange={(e) => setEndpointModel(e.target.value)}
                  placeholder="Test the endpoint to load models, or type an ID"
                  spellCheck={false}
                  className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
                />
              )}
            </div>

            <div className="rounded-xl border border-border bg-surface/30 p-3 text-xs leading-relaxed text-muted">
              <strong className="font-medium text-foreground">Current scope:</strong> local endpoints handle job evaluation directly. Actions that require browser/shell/file tools still use an installed agent CLI when available.
            </div>
          </div>
        )}
      </div>

      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        Appearance
      </label>
      <button
        type="button"
        onClick={() => setLogos((v) => !v)}
        className="flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-surface/50 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">Company logos</span>
          <span className="mt-0.5 block text-xs text-faint">
            Show each company&apos;s real logo. Fetched once through your local server and cached on disk — only the employer domain is sent to a third party. Off = colored monograms only.
          </span>
        </span>
        <span className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", logos ? "bg-brand" : "bg-surface-hover") }>
          <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform", logos ? "translate-x-[1.375rem]" : "translate-x-0.5") } />
        </span>
      </button>

      <CadenceSettings />

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || mode === "manual"}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : null}
          {saving ? "Saving…" : saved ? "Saved" : "Save settings"}
        </button>
        <span className="text-xs text-faint">AI engine is saved on this Career-Ops server.</span>
      </div>
      {saveError && <p className="mt-2 flex items-center gap-1.5 text-xs text-red-400"><AlertCircle className="size-3.5" /> {saveError}</p>}
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon: Icon,
  title,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border px-4 py-3 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-border bg-surface/30 opacity-55"
          : active
            ? "border-brand/50 bg-brand-soft"
            : "border-border bg-surface/50 hover:bg-surface-hover",
      )}
    >
      <Icon className={cn("size-4", active && !disabled ? "text-brand" : "text-muted")} />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-xs text-faint">{hint}</span>
    </button>
  );
}
