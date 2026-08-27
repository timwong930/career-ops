// Pure helpers for user-configured OpenAI-compatible local endpoints (oMLX,
// LM Studio, Ollama's OpenAI shim, etc.). Kept Node-free so the same validation
// can be unit-tested and reused by API routes.

/** Normalize a user-entered base URL. A bare server root gets the conventional /v1. */
export function normalizeOpenAiBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Endpoint URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Endpoint must be a valid http:// or https:// URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Endpoint must use http:// or https://");
  }
  url.hash = "";
  url.search = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") pathname = "/v1";
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

/**
 * The dashboard may send the endpoint URL from a remote browser, so never turn
 * this API into a general-purpose SSRF proxy. Custom endpoints are deliberately
 * limited to loopback, RFC1918 LAN, Tailscale CGNAT, .local and .ts.net hosts.
 */
export function isAllowedLocalAiEndpoint(value) {
  let url;
  try {
    url = new URL(normalizeOpenAiBaseUrl(value));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (host.endsWith(".local") || host.endsWith(".ts.net")) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;

  // Tailscale IPv4 addresses are allocated from 100.64.0.0/10.
  const m = host.match(/^100\.(\d{1,3})\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 64 && second <= 127) return true;
  }

  // IPv6 ULA (fc00::/7) and link-local are reasonable local inference targets.
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true;
  return false;
}

export function modelsUrl(baseUrl) {
  return `${normalizeOpenAiBaseUrl(baseUrl)}/models`;
}

export function chatCompletionsUrl(baseUrl) {
  return `${normalizeOpenAiBaseUrl(baseUrl)}/chat/completions`;
}

export function parseModelIds(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => (typeof row?.id === "string" ? row.id.trim() : ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export function parseEvaluationMetadata(report) {
  const text = String(report ?? "");
  const title = text.match(/^#\s*Evaluation:\s*(.+?)\s+(?:—|–|-)\s+(.+?)\s*$/mi);
  // Local models occasionally add emphasis around the value even when the
  // canonical template says not to. Accept that cosmetic variation while still
  // requiring a real 0–5 score and the canonical Score header.
  const score = text.match(/^\*\*Score:\*\*\s*\*{0,2}\s*([0-5](?:\.\d+)?)\s*\/\s*5\s*\*{0,2}\s*$/mi);
  if (!title || !score) return null;
  const value = Number(score[1]);
  if (!Number.isFinite(value) || value < 0 || value > 5) return null;
  return {
    company: title[1].trim(),
    role: title[2].trim(),
    score: value,
  };
}

export function stripOuterMarkdownFence(value) {
  const text = String(value ?? "").trim();
  const m = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (m ? m[1] : text).trim();
}
