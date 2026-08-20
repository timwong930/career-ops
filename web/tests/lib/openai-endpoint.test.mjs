import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletionsUrl,
  isAllowedLocalAiEndpoint,
  modelsUrl,
  normalizeOpenAiBaseUrl,
  parseEvaluationMetadata,
  parseModelIds,
  stripOuterMarkdownFence,
} from "../../src/lib/openai-endpoint.mjs";

test("normalizes conventional OpenAI-compatible base URLs", () => {
  assert.equal(normalizeOpenAiBaseUrl("http://127.0.0.1:8000"), "http://127.0.0.1:8000/v1");
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:8000/v1/"), "http://localhost:8000/v1");
  assert.equal(modelsUrl("http://localhost:8000"), "http://localhost:8000/v1/models");
  assert.equal(chatCompletionsUrl("http://localhost:8000/v1"), "http://localhost:8000/v1/chat/completions");
});

test("allows loopback, LAN and Tailscale endpoints but not public SSRF targets", () => {
  for (const url of [
    "http://localhost:8000/v1",
    "http://127.0.0.1:8000/v1",
    "http://192.168.1.10:8000/v1",
    "http://10.0.0.5:8000/v1",
    "http://172.20.1.5:8000/v1",
    "http://100.100.20.30:8000/v1",
    "https://mac-studio.tail1234.ts.net/v1",
    "http://mac-studio.local:8000/v1",
  ]) assert.equal(isAllowedLocalAiEndpoint(url), true, url);

  assert.equal(isAllowedLocalAiEndpoint("https://api.openai.com/v1"), false);
  assert.equal(isAllowedLocalAiEndpoint("http://169.254.169.254/latest"), false);
});

test("parses OpenAI model lists", () => {
  assert.deepEqual(parseModelIds({ data: [{ id: "qwen" }, { id: "mlx-model" }, { nope: true }] }), ["mlx-model", "qwen"]);
});

test("parses canonical evaluation metadata and strips an outer markdown fence", () => {
  const report = stripOuterMarkdownFence(`\`\`\`markdown\n# Evaluation: Acme — Project Manager\n\n**Score:** 4.3/5\n\`\`\``);
  assert.deepEqual(parseEvaluationMetadata(report), { company: "Acme", role: "Project Manager", score: 4.3 });
});

test("accepts cosmetic bolding around a local model score", () => {
  const report = "# Evaluation: Acme — Project Manager\n\n**Score:** **4.3/5**";
  assert.deepEqual(parseEvaluationMetadata(report), { company: "Acme", role: "Project Manager", score: 4.3 });
});
