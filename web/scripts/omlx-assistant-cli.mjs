#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file, maxChars, { tail = false } = {}) {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.length <= maxChars) return text;
    return tail ? text.slice(-maxChars) : text.slice(0, maxChars);
  } catch {
    return "";
  }
}

function normalizeBaseUrl(value) {
  const u = new URL(String(value || "").trim());
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "");
  if (!u.pathname || u.pathname === "/") u.pathname = "/v1";
  return u.toString().replace(/\/$/, "");
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("");
}

function currentReportContext(root, prompt) {
  const match = prompt.match(/application\s+#(\d+)/i);
  if (!match) return "";
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return "";
  let files = [];
  try {
    files = fs.readdirSync(path.join(root, "reports"));
  } catch {
    return "";
  }
  const file = files.find((name) => name.endsWith(".md") && parseInt(name, 10) === n && !name.includes("RESERVED"));
  return file ? readText(path.join(root, "reports", file), 18_000) : "";
}

function localEndpointApiKey(baseUrl) {
  const explicit = String(
    process.env.CAREER_OPS_ENDPOINT_API_KEY ||
      process.env.OMLX_API_KEY ||
      "",
  ).trim();
  if (explicit) return explicit;

  // oMLX persists its own API key in ~/.omlx/settings.json. Reading that file
  // keeps the secret local to the Mac and avoids duplicating it into Career-Ops.
  // Only use this fallback for an oMLX-style local endpoint.
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!isLocal) return "";
  } catch {
    return "";
  }

  const settings = readJson(path.join(os.homedir(), ".omlx", "settings.json"));
  const candidates = [
    settings?.api_key,
    settings?.apiKey,
    settings?.auth?.api_key,
    settings?.auth?.apiKey,
  ];
  for (const candidate of candidates) {
    const key = typeof candidate === "string" ? candidate.trim() : "";
    if (key) return key;
  }
  return "";
}

async function main() {
  const prompt = String(process.argv[2] || "").trim();
  if (!prompt) throw new Error("assistant prompt missing");

  // The assistant route launches this script with cwd set to the Career-Ops root.
  const root = process.cwd();
  const config = readJson(path.join(root, "data", "web-ai.json"));
  if (config?.mode !== "endpoint" || !config?.endpoint?.baseUrl || !config?.endpoint?.model) {
    throw new Error("No local/custom endpoint is configured in Settings → AI Engine");
  }

  const baseUrl = normalizeBaseUrl(config.endpoint.baseUrl);
  const model = String(config.endpoint.model);
  const apiKey = localEndpointApiKey(baseUrl);

  const cv = readText(path.join(root, "cv.md"), 28_000);
  const profile = readText(path.join(root, "config", "profile.yml"), 12_000);
  const applications = readText(path.join(root, "data", "applications.md"), 18_000, { tail: true });
  const pipeline = readText(path.join(root, "data", "pipeline.md"), 14_000, { tail: true });
  const report = currentReportContext(root, prompt);

  const localContext = [
    cv && `\n\n--- LOCAL CV (trusted Career-Ops data) ---\n${cv}`,
    profile && `\n\n--- LOCAL TARGET PROFILE ---\n${profile}`,
    applications && `\n\n--- RECENT APPLICATION TRACKER ---\n${applications}`,
    pipeline && `\n\n--- PENDING / DISCOVERED PIPELINE ---\n${pipeline}`,
    report && `\n\n--- CURRENT EVALUATION REPORT ---\n${report}`,
  ].filter(Boolean).join("");

  const system = `You are running as the Career-Ops assistant through the user's LOCAL OpenAI-compatible endpoint (for example oMLX). You have NO shell, filesystem, browser, or web-search tools. The dashboard prompt below defines the assistant behavior and action-envelope grammar. Follow it exactly.\n\nThe local Career-Ops data you are allowed to use is appended to the prompt as trusted context. Never claim you read, searched, browsed, fetched, or inspected anything beyond that supplied context. Never invent a job URL.\n\nYou MAY emit dashboard action envelopes for navigation, filtering, evaluation of a concrete supplied URL, evaluateCompany, status changes, apply-field edits, remember, profile/portal updates, and discovery/filter actions when justified. Do NOT emit the research action or generatePdf action in local-endpoint mode because those require an agent runtime with capabilities this model does not have; explain that limitation briefly if the user asks for those operations. Keep answers concise and concrete.`;

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${prompt}${localContext}` },
      ],
      temperature: 0.2,
      max_tokens: 3000,
      stream: false,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 400);
    const authHint = response.status === 401 && !apiKey
      ? " (No API key was found in the process environment or ~/.omlx/settings.json.)"
      : "";
    throw new Error(`Local endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}${authHint}`);
  }

  const payload = await response.json();
  const text = messageText(payload?.choices?.[0]?.message).trim();
  if (!text) throw new Error("Local endpoint returned an empty assistant response");
  process.stdout.write(text);
}

main().catch((err) => {
  process.stderr.write(`Local endpoint assistant error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
