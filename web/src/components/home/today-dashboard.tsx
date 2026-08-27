"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CircleHelp, Sparkles, ArrowRight, BriefcaseBusiness, Target, MessagesSquare, Trophy } from "lucide-react";
import { instrumentSerif } from "@/lib/fonts";
import { HeroGlow } from "@/components/hero-glow";
import type { Application, InboxJob } from "@/lib/career-ops";
import type { DiscoveredOffer } from "@/lib/explore";
import { DiscoveryCard } from "@/components/explore/discovery-card";
import { FollowUpCard, type FollowUp } from "@/components/home/follow-up-card";
import { DecisionCard } from "@/components/home/decision-card";
import { QuickEvaluate } from "@/components/quick-evaluate";
import { canonStatus, scoreNum } from "@/lib/format";

// The retention "Today": a dual-loop action queue (the maintainer's
// "N new matches this week · M follow-ups due"). SUPPLY loop = fresh free-scan
// matches (zero tokens, /api/whats-new); DEMAND loop = follow-ups due
// (/api/followups). Each item one-tap actionable. Home stays a VIEW over the
// canonical files — every action dispatches a real registry action / route.
export function TodayDashboard({
  applications,
  inbox,
  inBetween,
}: {
  applications: Application[];
  inbox: InboxJob[];
  inBetween: boolean;
}) {
  const [followups, setFollowups] = useState<FollowUp[]>([]);
  const [overdue, setOverdue] = useState(0);
  const [fresh, setFresh] = useState<DiscoveredOffer[]>([]);
  const router = useRouter();
  const dateLabel = useMemo(() => new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }), []);

  const refetch = useCallback(() => {
    fetch("/api/followups")
      .then((r) => r.json())
      .then((d) => {
        setFollowups(Array.isArray(d.entries) ? d.entries : []);
        setOverdue(d.metadata?.overdue ?? d.entries?.length ?? 0);
      })
      .catch(() => {});
    fetch("/api/whats-new")
      .then((r) => r.json())
      .then((d) => setFresh(Array.isArray(d.offers) ? d.offers : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refetch();
    // A worker (evaluate/pdf) just wrote a real tracker row — refresh the server
    // snapshot (applications/inbox props) + the client loops so the freshly-scored
    // role appears in "Awaiting your decision" without a manual reload.
    const onDone = () => {
      router.refresh();
      refetch();
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [refetch, router]);

  // Awaiting decision: scored (Evaluated) but no terminal status yet.
  const awaiting = useMemo(
    () => applications.filter((a) => /^evaluat/i.test(a.status)).slice(0, 6),
    [applications],
  );

  const newThisWeek = fresh.length;
  const allClear = newThisWeek === 0 && overdue === 0 && awaiting.length === 0;
  const inboxUrls = useMemo(() => new Set(inbox.map((j) => j.url)), [inbox]);

  const overview = useMemo(() => {
    const scored = applications
      .map((app) => scoreNum(app.score))
      .filter((score) => Number.isFinite(score));
    const average = scored.length ? scored.reduce((sum, score) => sum + score, 0) / scored.length : null;
    const interviews = applications.filter((app) => canonStatus(app.status).includes("INTERVIEW")).length;
    const offers = applications.filter((app) => {
      const status = canonStatus(app.status);
      return status.includes("OFFER") || status.includes("HIRED");
    }).length;
    const active = applications.filter((app) => {
      const status = canonStatus(app.status);
      return !["REJECTED", "DISCARDED", "SKIP", "HIRED"].some((terminal) => status.includes(terminal));
    }).length;
    return { average, interviews, offers, active };
  }, [applications]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 max-sm:pb-24">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-9 md:px-10 md:py-10">
        <HeroGlow />
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
        <div className="relative z-10">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> overview · <span className="tabular-nums">{dateLabel}</span>
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 max-w-2xl text-4xl leading-[1.05] text-landing md:text-5xl`}>
            Your job search, <span className="text-brand">in one place.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-sm text-muted">
            Evaluate roles, track applications, handle follow-ups, and prepare for interviews without living in the terminal.
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Link href="/explore" className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 max-sm:min-h-[44px]">
              Discover jobs <ArrowRight className="size-4" />
            </Link>
            <Link href="/pipeline?tab=ALL" className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]">
              View applications
            </Link>
          </div>
        </div>
      </section>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard icon={BriefcaseBusiness} label="Active applications" value={String(overview.active)} hint={`${applications.length} tracked total`} />
        <MetricCard icon={Target} label="Average fit" value={overview.average == null ? "—" : `${overview.average.toFixed(1)}/5`} hint="Across scored roles" />
        <MetricCard icon={MessagesSquare} label="Interviews" value={String(overview.interviews)} hint={overdue > 0 ? `${overdue} follow-up${overdue === 1 ? "" : "s"} due` : "No follow-ups overdue"} />
        <MetricCard icon={Trophy} label="Offers" value={String(overview.offers)} hint={newThisWeek > 0 ? `${newThisWeek} fresh match${newThisWeek === 1 ? "" : "es"}` : "Keep the funnel moving"} />
      </div>

      <QuickEvaluate />
      {inBetween && <p className="mt-2 text-xs text-faint">Finish your setup when you can; evaluation still works with the profile data already available.</p>}

      {followups.length > 0 && (
        <Section icon={Bell} title="Follow-ups due" hint="Keep your applications moving">
          <div className="grid gap-2.5">
            {followups.map((f) => (
              <FollowUpCard key={`${f.num}-${f.company}`} followup={f} onLogged={() => setOverdue((n) => Math.max(0, n - 1))} />
            ))}
          </div>
        </Section>
      )}

      {awaiting.length > 0 && (
        <Section icon={CircleHelp} title="Ready for your decision" hint="Career-Ops scored these — apply or skip">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {awaiting.map((a) => (
              <DecisionCard key={a.n} app={a} />
            ))}
          </div>
        </Section>
      )}

      {fresh.length > 0 && (
        <Section icon={Sparkles} title="Fresh matches" hint="New roles found by your scans">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {fresh.slice(0, 6).map((o) => (
              <DiscoveryCard key={o.url} offer={o} inPipeline={inboxUrls.has(o.url)} />
            ))}
          </div>
          {fresh.length > 6 && (
            <Link href="/explore?view=fresh" className="mt-3 inline-flex items-center text-sm text-muted transition hover:text-brand max-sm:min-h-[44px]">
              See all {fresh.length} →
            </Link>
          )}
        </Section>
      )}

      {allClear && applications.length > 0 && (
        <div className="mt-8 rounded-2xl border border-border bg-surface/30 px-6 py-8 text-center">
          <Sparkles className="mx-auto size-6 text-brand" />
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Nothing needs your attention right now. <Link href="/explore" className="text-brand hover:underline">Discover more roles</Link> or review your <Link href="/pipeline?tab=ALL" className="text-brand hover:underline">applications</Link>.
          </p>
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, hint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/55 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        <Icon className="size-4 text-brand/70" />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-landing tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-faint">{hint}</p>
    </div>
  );
}

function Section({ icon: Icon, title, hint, children }: { icon: React.ComponentType<{ className?: string }>; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-brand" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">{title}</h2>
        <span className="text-xs text-faint">· {hint}</span>
      </div>
      {children}
    </section>
  );
}
