import { allowedDevOriginsFromHosts, parseExtraHosts } from "./src/lib/network-hosts.mjs";

const networkHosts = parseExtraHosts(process.env.CAREER_OPS_WEB_ALLOWED_HOSTS);
const allowedDevOrigins = allowedDevOriginsFromHosts(networkHosts);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Two lockfiles exist on purpose (repo root + web/), so Next would infer the
  // repo root as the workspace root. On Windows that misinference can send
  // Turbopack's postcss workers into an unbounded respawn loop that exhausts
  // all RAM (vercel/next.js#92978) — pin the root to this app.
  turbopack: { root: import.meta.dirname },
  // Allow a throwaway build dir (e.g. BUILD_DIST=.next-prod) so a production
  // `next build` can run without clobbering a live `next dev` .next.
  ...(process.env.BUILD_DIST ? { distDir: process.env.BUILD_DIST } : {}),
  // When the explicit LAN/Tailscale launcher is used, Next dev also needs to
  // accept requests for its internal development assets from those hostnames.
  // Production requests are still governed by the API origin guard.
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
};

export default nextConfig;
