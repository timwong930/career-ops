# career-ops web (alpha)

An **experimental, opt-in web UI** for career-ops. It is a local-first *view* over
the exact same files the CLI reads and writes (`data/pipeline.md`,
`data/applications.md`, `reports/`, `config/`): no parallel engine, no separate
database. If you never run it, nothing about your CLI workflow changes.

> **Status: alpha.** Expect rough edges. Feedback →
> [Discussion #1142](https://github.com/santifer/career-ops/discussions/1142) ·
> roadmap context → [Discussion #156](https://github.com/santifer/career-ops/discussions/156).

## Quick start

Requires Node 22+.

```bash
cd web
npm ci
npm run dev
```

Open http://localhost:2000. The app reads the career-ops checkout it lives in
(the parent directory) — your existing CV, pipeline and reports appear as-is.

## LAN, headless Macs, and Tailscale

The normal `dev` / `start` commands keep the API's loopback-only safety policy.
For a trusted home LAN or a headless machine, use the explicit network commands:

```bash
# Development / live reload
npm run dev:lan

# Recommended for a headless machine
npm run build
npm run start:lan
```

`dev:lan` and `start:lan` bind Next.js to `0.0.0.0` and automatically allow the
server's own non-loopback interface addresses, macOS hostname / `.local` name,
and — when the Tailscale CLI is available — its Tailscale IPs and MagicDNS name.
The existing same-origin API guard remains enabled.

From another device on the LAN, open either:

```text
http://<mac-lan-ip>:2000
http://<mac-hostname>.local:2000
```

For remote access over your tailnet, direct access to the Mac's Tailscale IP or
MagicDNS name works as well. For a stable HTTPS URL, Tailscale Serve is preferred:

```bash
tailscale serve --bg 2000
```

Tailscale will proxy its HTTPS MagicDNS URL to `127.0.0.1:2000` and persist the
Serve configuration across restarts. If the Tailscale CLI is not discoverable by
Node, add a custom DNS name explicitly when launching:

```bash
CAREER_OPS_WEB_ALLOWED_HOSTS=mac-studio.example.ts.net npm run start:lan
```

**Security note:** the web UI can run Career-Ops workers and write your local
career files. `start:lan` intentionally makes it reachable by devices that can
connect to this Mac on the trusted network. Do not expose port 2000 to the public
internet. Prefer Tailscale ACLs / Serve for remote access; do not use Tailscale
Funnel for this app.

## Local AI / oMLX

The web UI can use a local **OpenAI-compatible endpoint** without requiring Codex
or Claude for the supported inference workflows. This is designed for a headless
Mac running oMLX, but the same path works with compatible inference servers on
loopback, the trusted LAN, or Tailscale.

In **Settings → AI Engine → Local / custom endpoint**:

1. Enter the base URL. The oMLX default is:

   ```text
   http://127.0.0.1:8000/v1
   ```

2. Click **Test connection & load models**. The server calls `/v1/models` from
   the Mac that runs Career-Ops, so a phone connected over Tailscale can still
   configure an oMLX process bound only to the Mac's localhost interface.
3. Pick a model and click **Save settings**.

The endpoint/model choice is persisted in `data/web-ai.json`, which is already
covered by the repository's `data/*` ignore rule. Optional API keys are **not**
written to disk; they live only in the current browser session.

Custom endpoint URLs are intentionally restricted to loopback, private-LAN,
`.local`, and Tailscale addresses. This prevents the dashboard's API from becoming
an arbitrary outbound proxy.

### Local job evaluation

Paste a job URL into **Evaluate a Job**. Career-Ops reads the job page, combines
it with `modes/oferta.md`, `config/profile.yml`, and `cv.md`, calls the selected
endpoint's `/v1/chat/completions`, then saves the report/tracker entry through
trusted backend code.

### Local AI Search

A raw local model has no trustworthy web-search tool, so Career-Ops does not ask
it to invent or browse job URLs. In local-endpoint mode AI Search uses a two-part
pipeline instead:

1. The selected local model converts the natural-language intent into broad title
   filters.
2. Career-Ops retrieves real postings from the public Greenhouse, Lever, Ashby,
   and Workday ATS network.
3. The local model ranks that retrieved candidate set and explains the strongest
   matches. It can select only URLs that Career-Ops actually retrieved.

This keeps job links grounded while still letting oMLX interpret searches such as
"project manager in Orange County or remote, not director-level".

### CV import

- Pasted CV text is always accepted for review, even if AI cleanup fails.
- On macOS, PDFs use native PDFKit text extraction before AI cleanup.
- DOC/DOCX/RTF files use macOS `textutil`.
- A configured local endpoint can normalize extracted text into Career-Ops
  markdown.
- Image-only/scanned PDFs still need OCR-capable fallback behavior (Claude Code
  remains available when configured).

## Discover / free scanner

The free **Scan** path uses the core reverse-ATS scanner and zero LLM tokens. The
web UI caps each ATS to keep an interactive scan bounded. The core scanner's
native capped behavior uses the alphabetical first N companies, which is heavily
biased; the web adapter therefore adds `--shuffle` so each capped run samples the
public company directory instead of repeatedly scanning the same A-first slice.

If the scanner exits or returns malformed output, the UI now surfaces the useful
tail of the scanner error rather than collapsing every failure to "no readable
output".

## What works today

- **Applications** — your tracker as a sortable, filterable table; status changes
  write back through the core's own scripts.
- **Discover / Scan** — free reverse-ATS discovery with capped-scan transparency.
- **AI Search** — CLI agents can search the open web; local OpenAI-compatible
  endpoints use grounded ATS retrieval + local ranking.
- **Evaluate** — score a job through an installed agent CLI or a local
  OpenAI-compatible endpoint such as oMLX.
- **Apply** — assisted form prefill with a hard rule inherited from the core:
  **it never submits for you** — you always press the button.
- **Overview / Analytics / Resume / Settings** — action queue, funnel, CV editing
  with preview, and configuration.

## Safety

- **Local-first:** the local web app runs on your machine — no Career-Ops cloud
  account is needed. Your CV and data stay in your own files unless you choose a
  non-local AI provider.
- **Never auto-submits:** the apply flow drafts and prefills; submitting is
  always a human action.
- **Local endpoint writes stay backend-owned:** the inference model receives the
  required context and returns text; it never receives shell or file tools.
  Career-Ops validates responses and performs report/tracker writes itself.
- **Local AI Search never trusts model-generated job URLs:** the model may rank
  only URLs returned by the deterministic ATS retrieval stage.
- **CV generation never asks the agent to write:** the `pdf` worker tailors your
  CV and emits it inline in a `<<cv-html>>` envelope; the backend parses that
  envelope, writes the HTML, and renders the PDF itself.
- **Additive:** the web is isolated from the core's packaging, CI and release
  automation. The CLI works exactly the same without it.

## Development

```bash
npm run dev          # loopback-safe dev server (Turbopack, port 2000)
npm run dev:lan      # trusted LAN/Tailscale dev server (port 2000)
npm test             # unit suites (node --test, no framework)
npx tsc --noEmit     # typecheck
npm run build        # production build
npm run start:lan    # production server for trusted LAN/Tailscale access
```

Set `CAREER_OPS_ROOT=/path/to/checkout` in `web/.env.local` to point the app at
a different career-ops directory (useful for testing against sample data).

### Tests

Suites live in `web/tests/`, mirroring the path of what they test under
`web/src/` — so `src/lib/clean-chips.mjs` is tested by
`tests/lib/clean-chips.test.mjs`. Name the file `{module}.test.mjs`.

`npm test` discovers them with a glob (`tests/**/*.test.mjs`), so a new suite
needs **no registration** — just add the file. **Requires Node ≥ 22**: earlier
versions don't expand CLI globs for `node --test`, so `npm test` prints
`Could not find '…'`, runs nothing and exits 1. Hence `engines.node` in
`web/package.json` — a higher floor than `next` itself asks for.

Three constraints follow from all this:

- **Keep tests out of `src/`.** `src/` is the Next.js app's own tree, scanned by
  `next build`'s file tracing and `tsc --noEmit`; test files there entangle
  fixtures with build and route conventions.
- **Use `.mjs`, not `.ts`.** There is no test framework and no TypeScript loader
  by design — `node --test` cannot run a `.ts` suite, so one would look like
  coverage and never execute. Extract the logic under test into a plain `.mjs`
  module and import it from the test.
- **Web suites use `node:test`; core suites don't.** Here you write
  `import { test } from "node:test"` with `node:assert/strict`. The root
  `tests/` suite deliberately uses neither — it has its own helpers so the core
  suite can run on a bare clone.
