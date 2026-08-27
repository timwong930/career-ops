import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { careerOpsRoot } from "@/lib/career-ops";
import { isAllowedLocalAiEndpoint, normalizeOpenAiBaseUrl } from "@/lib/openai-endpoint.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StoredAiConfig = {
  mode: "cli" | "endpoint";
  cliId?: string;
  endpoint?: { baseUrl: string; model: string };
};

const DEFAULT_CONFIG: StoredAiConfig = { mode: "cli" };

function configPath() {
  return path.join(careerOpsRoot(), "data", "web-ai.json");
}

function readConfig(): StoredAiConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (parsed?.mode === "endpoint" && parsed?.endpoint?.baseUrl && parsed?.endpoint?.model) {
      return {
        mode: "endpoint",
        endpoint: {
          baseUrl: normalizeOpenAiBaseUrl(parsed.endpoint.baseUrl),
          model: String(parsed.endpoint.model),
        },
      };
    }
    if (parsed?.mode === "cli") {
      return { mode: "cli", cliId: typeof parsed.cliId === "string" ? parsed.cliId : undefined };
    }
  } catch {
    // Fresh install / malformed local file → safe CLI default.
  }
  return DEFAULT_CONFIG;
}

export async function GET() {
  return NextResponse.json({ config: readConfig() });
}

export async function POST(req: Request) {
  let body: { mode?: string; cliId?: string; endpoint?: { baseUrl?: string; model?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  let next: StoredAiConfig;
  if (body.mode === "endpoint") {
    const baseUrl = String(body.endpoint?.baseUrl ?? "").trim();
    const model = String(body.endpoint?.model ?? "").trim();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "Endpoint URL and model are required" }, { status: 400 });
    }
    if (!isAllowedLocalAiEndpoint(baseUrl)) {
      return NextResponse.json(
        { error: "Custom AI endpoints must be loopback, LAN, .local, or Tailscale addresses" },
        { status: 400 },
      );
    }
    next = { mode: "endpoint", endpoint: { baseUrl: normalizeOpenAiBaseUrl(baseUrl), model } };
  } else if (body.mode === "cli") {
    next = { mode: "cli", cliId: typeof body.cliId === "string" && body.cliId ? body.cliId : undefined };
  } else {
    return NextResponse.json({ error: "Unsupported AI mode" }, { status: 400 });
  }

  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return NextResponse.json({ ok: true, config: next });
}
