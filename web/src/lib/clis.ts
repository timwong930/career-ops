import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexStreamArgs, isFatalClaudeStderr, isFatalCodexStderr, parseClaudeEvent, parseCodexEvent } from "./run-cli-support.mjs";

// Server-only (node imports). The agnostic runtimes career-ops can delegate to
// in headless mode (AGENTS.md). Install URLs from career-ops-docs.
export type CliSpec = {
  id: string;
  name: string;
  bin: string;
  run: string;
  url: string;
  /** headless invocation args for a single prompt, emitting PLAIN TEXT on stdout.
   * Every caller that reads the output itself (the `<<offer:>>`/`<<cv:>>` envelope
   * routes, the apply planners) uses this, so it must stay unstructured. */
  args: (prompt: string) => string[];
  /** Structured-output CLIs only: args for a run whose stdout the caller parses
   * with `parseEvent` — i.e. /api/run's dashboard stream, the one consumer that
   * understands events. Absent → that caller falls back to `args`.
   *
   * INVARIANT: `parseEvent` only applies to output produced by THIS argv (for
   * claude, by claude-invocation.mjs's `claudeCliArgs`, which spells its own
   * `--output-format stream-json`). Pairing one CLI's parser with a plain-text
   * invocation yields a silent stream of unparseable lines. */
  streamArgs?: (prompt: string) => string[];
  /** Structured-output CLIs only: parse one stdout line into dashboard events.
   * Absent → the route streams stdout as raw text (the default for every CLI
   * without its own structured output format). */
  parseEvent?: (line: string) => import("./run-cli-support.mjs").ParsedEvent | null;
  /** Structured-output CLIs only: decide whether a stderr line is fatal.
   * Absent → the route falls back to the shared generic error regex. */
  stderrIsFatal?: (line: string) => boolean;
};

function careerRootForConfig(): string {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  return env || path.resolve(process.cwd(), "..");
}

function localEndpointConfigured(): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ path.join(careerRootForConfig(), "data", "web-ai.json"), "utf8"));
    return cfg?.mode === "endpoint" && Boolean(cfg?.endpoint?.baseUrl) && Boolean(cfg?.endpoint?.model);
  } catch {
    return false;
  }
}

function localEndpointAdapterArgs(prompt: string): string[] {
  // Next runs with web/ as cwd. Use an absolute script path because the
  // assistant child itself is launched with cwd changed to the Career-Ops root.
  const script = path.resolve(process.cwd(), "scripts", "omlx-assistant-cli.mjs");
  return [script, prompt];
}

/**
 * NO RUNTIME HERE MAY GRANT ITSELF MORE PERMISSION THAN THE AUDITED ONE.
 *
 * The permission model is per-worker AND per-CLI, but only one axis is written
 * down: WRITE_CAPABLE_TOOLS and the per-kind deny lists live in
 * claude-invocation.mjs — i.e. on Claude's path. A new CLI arriving with a
 * blanket auto-approve flag (`--always-approve`, `--yolo`,
 * `--dangerously-skip-permissions`, `--yes`) is not breaking that rule; it is
 * entering where the rule does not exist.
 *
 * Concretely: the `pdf` worker has Bash explicitly denied and must never regain
 * it. Pair Grok with `--always-approve` and that same worker gets Write and
 * Bash auto-approved — so the user's choice of runtime silently changes what a
 * worker may do to their files, while both paths look identical in the UI.
 *
 * If a CLI has no per-tool deny list to pair with, the answer is NOT to
 * auto-approve: it is to withhold the workers that write. Needing such a flag
 * to make a runtime work is a core architecture issue, not a line inside a
 * CLI-support PR.
 *
 * Enforced by tests/lib/clis-permissions.test.mjs, because a rule that only
 * lives in a comment is a rule the next contributor may never read.
 */
export const KNOWN: CliSpec[] = [
  // Synthetic runtime for the assistant only: Node invokes a tiny adapter that
  // calls the server's saved OpenAI-compatible endpoint (e.g. oMLX). It has no
  // shell/browser/filesystem tools; the adapter supplies bounded local context.
  { id: "omlx", name: "Local endpoint (oMLX)", bin: "node", run: "OpenAI-compatible /v1", url: "https://github.com/jundot/omlx", args: localEndpointAdapterArgs },
  { id: "claude", name: "Claude Code", bin: "claude", run: "claude -p", url: "https://claude.ai/code", args: (p) => ["-p", p], parseEvent: parseClaudeEvent, stderrIsFatal: isFatalClaudeStderr },
  { id: "codex", name: "Codex", bin: "codex", run: "codex exec", url: "https://github.com/openai/codex", args: (p) => ["exec", p], streamArgs: codexStreamArgs, parseEvent: parseCodexEvent, stderrIsFatal: isFatalCodexStderr },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", run: "gemini -p", url: "https://github.com/google-gemini/gemini-cli", args: (p) => ["-p", p] },
  { id: "opencode", name: "OpenCode", bin: "opencode", run: "opencode run", url: "https://opencode.ai", args: (p) => ["run", p] },
  { id: "copilot", name: "GitHub Copilot CLI", bin: "copilot", run: "copilot -p", url: "https://docs.github.com/en/copilot/github-copilot-in-the-cli", args: (p) => ["-p", p] },
  { id: "qwen", name: "Qwen CLI", bin: "qwen", run: "qwen -p", url: "https://qwen.ai/qwencode", args: (p) => ["-p", p] },
  { id: "antigravity", name: "Antigravity CLI", bin: "agy", run: "agy -p", url: "https://antigravity.google", args: (p) => ["-p", p] },
  // Grok Build also speaks `--output-format streaming-json`, but that is its own
  // schema, not Claude's `stream-json` — and the run route only parses the
  // latter. Plain `-p` streams text, which is what every other non-Claude entry
  // here does.
  { id: "grok", name: "Grok Build CLI", bin: "grok", run: "grok -p", url: "https://docs.x.ai/build/overview", args: (p) => ["-p", p] },
];

function searchDirs(): string[] {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".deno/bin"),
    path.join(home, ".opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  if (process.platform === "win32") {
    // Windows CLIs frequently install under per-user AppData roots and don't
    // reliably add themselves to PATH (e.g. Antigravity → %LOCALAPPDATA%\\agy\\bin).
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    extra.push(
      path.join(localAppData, "agy", "bin"),
      path.join(localAppData, "Microsoft", "WindowsApps"),
      path.join(appData, "npm"),
    );
  }
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...extra])];
}

function binCandidates(bin: string): string[] {
  if (process.platform !== "win32") return [bin];
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = pathext
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    .filter((e) => [".com", ".exe", ".bat", ".cmd"].includes(e.toLowerCase()));
  return [bin, ...exts.map((ext) => bin + ext)];
}

export function findBin(bin: string, dirs = searchDirs()): string | null {
  for (const dir of dirs) {
    for (const candidate of binCandidates(bin)) {
      const p = path.join(dir, candidate);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

export function detectClis() {
  const dirs = searchDirs();
  return KNOWN.map((c) => {
    if (c.id === "omlx") {
      const enabled = localEndpointConfigured();
      return { id: c.id, name: c.name, run: c.run, url: c.url, installed: enabled, path: enabled ? process.execPath : null };
    }
    const found = findBin(c.bin, dirs);
    return { id: c.id, name: c.name, run: c.run, url: c.url, installed: !!found, path: found };
  });
}

export function resolveCli(id: string): { spec: CliSpec; binPath: string } | null {
  const spec = KNOWN.find((c) => c.id === id);
  if (!spec) return null;
  if (id === "omlx") {
    return localEndpointConfigured() ? { spec, binPath: process.execPath } : null;
  }
  const binPath = findBin(spec.bin);
  if (!binPath) return null;
  return { spec, binPath };
}
