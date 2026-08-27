"use client";

import { useState } from "react";
import { ArrowRight, Link2, Sparkles } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";

// Auto-pipeline, one click: paste a job URL → fire a real evaluation worker
// (the same kind:"evaluate" that runs modes/oferta.md + writes the A–F report +
// tracker row). The worker pills + assistant cards show progress.
export function QuickEvaluate() {
  const { startJob } = useJobs();
  const [url, setUrl] = useState("");
  const [hint, setHint] = useState("");

  function run() {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      setHint("Paste a full job-posting URL starting with https://");
      return;
    }
    startJob({ title: "Evaluate · pasted URL", subtitle: u, kind: "evaluate", input: u, page: "/" });
    setUrl("");
    setHint("Evaluation started. You can keep using the app while Career-Ops works.");
  }

  return (
    <section className="mt-6 rounded-2xl border border-border bg-surface/80 p-4 shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Evaluate a job</h2>
              <p className="mt-0.5 text-xs text-muted">Paste a posting URL to get a fit score, full report, and application entry.</p>
            </div>
            <CostBadge kind="spend" size="xs" />
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
              <input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (hint) setHint("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") run();
                }}
                placeholder="https://company.com/jobs/role"
                aria-label="Job posting URL"
                className="w-full rounded-xl border border-border bg-background/70 py-2.5 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/30"
              />
            </div>
            <button
              onClick={run}
              className="inline-flex min-h-[42px] shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200"
            >
              Evaluate <ArrowRight className="size-4" />
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
            <span>Runs on your configured AI provider.</span>
            <span className="hidden sm:inline">·</span>
            <span>Your files stay local.</span>
          </div>
          {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
        </div>
      </div>
    </section>
  );
}
