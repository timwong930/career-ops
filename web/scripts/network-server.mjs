#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNetworkAllowedHosts, parseExtraHosts } from "../src/lib/network-hosts.mjs";

const mode = process.argv[2] === "dev" ? "dev" : "start";
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const port = String(process.env.PORT || "3000");

function tailscaleStatus() {
  try {
    const raw = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2500,
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const existingExtras = parseExtraHosts(process.env.CAREER_OPS_WEB_ALLOWED_HOSTS);
const ts = tailscaleStatus();
const allowedHosts = buildNetworkAllowedHosts({
  hostname: hostname(),
  interfaces: networkInterfaces(),
  tailscaleStatus: ts,
  extraHosts: existingExtras,
});

const env = {
  ...process.env,
  CAREER_OPS_WEB_ALLOWED_HOSTS: allowedHosts.join(","),
};

const nextBin = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const args = [nextBin, mode, "-H", "0.0.0.0", "-p", port];

console.log(`career-ops web (${mode})`);
console.log(`Listening on all interfaces at port ${port}.`);
if (allowedHosts.length) {
  console.log("Trusted server addresses/names:");
  for (const host of allowedHosts) console.log(`  - ${host}`);
}
if (ts?.Self?.DNSName) {
  const dns = String(ts.Self.DNSName).replace(/\.$/, "");
  console.log(`Tailscale: http://${dns}:${port}`);
}
console.log("LAN: use this Mac's LAN IP or <hostname>.local with the same port.");
console.log("Only devices that can reach this Mac can connect; API requests remain same-origin guarded.\n");

const child = spawn(process.execPath, args, {
  cwd: webRoot,
  env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
