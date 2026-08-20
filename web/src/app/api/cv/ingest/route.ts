import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";
import {
  chatCompletionsUrl,
  isAllowedLocalAiEndpoint,
  normalizeOpenAiBaseUrl,
} from "@/lib/openai-endpoint.mjs";

// Parse a CV into clean cv.md markdown. Readable text is never dependent on an
// agent CLI: pasted text is accepted directly, and macOS uses native PDFKit /
// textutil to extract PDF/DOCX text. When a local OpenAI-compatible endpoint is
// configured (for example oMLX), it may normalize that text into Career-Ops
// markdown; if AI cleanup fails, the extracted text is still offered for review.
// Claude remains a last-resort parser for files whose text cannot be extracted.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const execFileAsync = promisify(execFile);

type EndpointConfig = { baseUrl: string; model: string };

function readCanonicalMode(): string | null {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), "modes", "cv-ingest.md"), "utf8");
  } catch {
    return null;
  }
}

function ingestPrompt(source: string): string {
  const mode = readCanonicalMode();
  if (mode) {
    return `${mode}\n\n--- HEADLESS OUTPUT CONTRACT (the career-ops WEB is parsing your stream) ---\nFollow the mode above exactly. You are a PROPOSER running headless: emit ONLY the markdown between <<cv:start>> and <<cv:end>> (own lines, never in a code fence), then one <<cv:seed>>{...} line; or <<cv:error>>{"reason":"unreadable"} if you can't read it. Narrate one short line before <<cv:start>>.\n\n${source}`;
  }
  return `You convert a person's CV into clean cv.md markdown that EXACTLY mirrors career-ops's reference format.

FORMAT (match exactly; omit a section if the source lacks it; INVENT NOTHING):
\`# CV -- {Full Name}\`
then bold contact lines directly under the title (no "Contact" section):
\`**Location:** …\` / \`**Email:** …\` / \`**LinkedIn:** …\` / \`**Portfolio:** …\` / \`**GitHub:** …\`
\`## Professional Summary\` — a 2-4 line summary, only from facts present.
\`## Work Experience\` — each role as: \`### {Company} -- {Location}\`, then \`**{Job Title}**\` on its own line, then \`{Start}-{End or Present}\` on its own line, then bullet points (preserve EVERY quantified achievement verbatim).
\`## Projects\` — flat bullets: \`- **{Name}** ({type}) -- {what + hero metric}\`.
\`## Education\` — flat bullets: \`- {Degree}, {Institution} ({year})\`.
\`## Skills\` — grouped bullets: \`- **{Category}:** {comma list}\`.
Use \`--\` (double hyphen), NEVER an em dash (ATS rule). Preserve every company/title/date/metric. Clean, don't rewrite — it's THEIR CV.

OUTPUT PROTOCOL:
- You are a PROPOSER: do NOT write any file. Emit ONLY the markdown wrapped EXACTLY between a line \`<<cv:start>>\` and a line \`<<cv:end>>\` (each on its own line, never inside a code fence).
- After \`<<cv:end>>\`, emit ONE more line: \`<<cv:seed>>{"title":"<their current/target role>","roles":["<3-5 role keywords>"],"location":"<their location or 'Remote'>"}\`
- If the source is unreadable or empty, emit ONLY: \`<<cv:error>>{"reason":"unreadable"}\` and stop.
- Narrate one short line BEFORE \`<<cv:start>>\` (e.g. "Reading your CV…").

${source}`;
}

const TEXT_SRC = (t: string) => `SOURCE (the user's CV, already extracted as readable text — convert it):\n"""\n${t.slice(0, 30000)}\n"""`;
const FILE_SRC = (p: string) => `SOURCE: the user's CV is the file at this local path — READ it with your file/Read tool, then convert it:\n${p}`;

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
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    }).join("");
  }
  return "";
}

function hasUsableCvEnvelope(value: string): boolean {
  const start = value.indexOf("<<cv:start>>");
  const end = value.indexOf("<<cv:end>>");
  if (start < 0 || end <= start) return false;
  return value.slice(start + "<<cv:start>>".length, end).trim().length >= 40;
}

function localTextResponse(text: string, note = "Imported locally.") {
  const safe = text
    .replace(/^\s*<<cv:(?:start|end|seed|error)>>.*$/gim, "")
    .trim()
    .slice(0, 40000);
  return new Response(`${note}\n<<cv:start>>\n${safe}\n<<cv:end>>\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

async function formatWithEndpoint(text: string, config: EndpointConfig, apiKey: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
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
        messages: [{ role: "user", content: ingestPrompt(TEXT_SRC(text)) }],
        temperature: 0.1,
        max_tokens: 7000,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`Local AI returned HTTP ${response.status}`);
    const payload = await response.json();
    const content = messageText(payload?.choices?.[0]?.message).trim();
    if (!hasUsableCvEnvelope(content)) throw new Error("Local AI did not return a usable CV envelope");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function extractLocalText(file: string, ext: string): Promise<string> {
  if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
    return fs.readFileSync(file, "utf8").trim();
  }
  if (process.platform !== "darwin") return "";

  if (ext === ".pdf") {
    const script = path.join(process.cwd(), "scripts", "extract-pdf-text.jxa.js");
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", script, file], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.trim();
  }

  if (ext === ".docx" || ext === ".doc" || ext === ".rtf") {
    const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", file], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.trim();
  }

  return "";
}

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") || "";
  let cliId = "";
  let apiKey = "";
  let promptSource = "";
  let sourceText = "";
  let tempFile: string | null = null;
  let ext = "";

  try {
    if (ctype.includes("application/json")) {
      const body = (await req.json()) as { text?: string; cliId?: string; apiKey?: string };
      cliId = body.cliId || "";
      apiKey = String(body.apiKey || "");
      sourceText = (body.text || "").trim();
      if (!sourceText) return Response.json({ error: "empty cv text" }, { status: 400 });
    } else if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      cliId = String(form.get("cliId") || "");
      apiKey = String(form.get("apiKey") || "");
      const file = form.get("file");
      if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
      ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".pdf").toLowerCase();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cv-"));
      tempFile = path.join(dir, `cv${ext}`);
      fs.writeFileSync(tempFile, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
      try {
        sourceText = (await extractLocalText(tempFile, ext)).trim();
      } catch {
        sourceText = "";
      }
      if (!sourceText) promptSource = FILE_SRC(tempFile);
    } else {
      return Response.json({ error: "unsupported content-type" }, { status: 400 });
    }
  } catch {
    if (tempFile) cleanupTemp(tempFile);
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  // Readable source text is already enough to continue. If oMLX / another local
  // endpoint is configured, let it normalize the CV; never let an AI formatting
  // failure turn readable user data into an "unreadable" error.
  if (sourceText) {
    const endpoint = readEndpointConfig();
    if (endpoint) {
      try {
        const content = await formatWithEndpoint(sourceText, endpoint, apiKey);
        if (tempFile) cleanupTemp(tempFile);
        return new Response(content, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      } catch {
        // Fall through to the guaranteed local-text review path.
      }
    }
    if (tempFile) cleanupTemp(tempFile);
    return localTextResponse(
      sourceText,
      endpoint ? "AI cleanup was unavailable, so I kept the locally extracted CV text for review." : "Imported locally.",
    );
  }

  // Native extraction can fail for image-only/scanned PDFs. Claude can still
  // read the temporary file if explicitly configured; other CLIs are not granted
  // file tools here, so fail clearly instead of pretending the document was empty.
  const resolved = resolveCli(cliId);
  if (!resolved || cliId !== "claude") {
    if (tempFile) cleanupTemp(tempFile);
    return Response.json(
      { error: "I couldn't extract selectable text from that file. If it is a scanned PDF, paste the resume text or use Claude Code for OCR/file reading." },
      { status: 422 },
    );
  }

  const { spec, binPath } = resolved;
  const prompt = ingestPrompt(promptSource);
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read,Glob,Grep",
    "--disallowedTools",
    "Bash,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch",
  ];

  let child;
  try {
    child = spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  } catch (e) {
    if (tempFile) cleanupTemp(tempFile);
    return Response.json({ error: e instanceof Error ? e.message : "failed to start the CLI" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 240_000);
      const safeClose = () => {
        if (!closed) {
          closed = true;
          if (killer) clearTimeout(killer);
          if (tempFile) cleanupTemp(tempFile);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      const safeEnqueue = (s: string): boolean => {
        if (closed || !s) return false;
        try {
          controller.enqueue(encoder.encode(s));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const emit = (s: string) => {
        if (safeEnqueue(s)) emitted = true;
      };

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
              const text = obj.event.delta?.text;
              if (typeof text === "string") emit(text);
            }
          } catch {
            /* partial / non-json line */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        if (/error|not found|denied|fatal/i.test(s)) safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`);
      });
      child.on("error", (e) => {
        safeEnqueue(`\n[error launching ${spec.name}: ${e.message}]`);
        safeClose();
      });
      child.on("close", () => {
        if (!emitted) safeEnqueue("<<cv:error>>{\"reason\":\"no-output\"}");
        safeClose();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      if (tempFile) cleanupTemp(tempFile);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function cleanupTemp(file: string) {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
