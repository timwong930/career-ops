import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedDevOriginsFromHosts,
  buildNetworkAllowedHosts,
  hostsFromInterfaces,
  hostsFromTailscaleStatus,
} from "../../src/lib/network-hosts.mjs";

test("collects non-internal LAN and Tailscale interface addresses", () => {
  const hosts = hostsFromInterfaces({
    lo0: [{ address: "127.0.0.1", internal: true, family: "IPv4" }],
    en0: [{ address: "192.168.1.42", internal: false, family: "IPv4" }],
    utun4: [
      { address: "100.101.102.103", internal: false, family: "IPv4" },
      { address: "fd7a:115c:a1e0::1234%utun4", internal: false, family: "IPv6" },
    ],
  });
  assert.deepEqual(hosts, ["192.168.1.42", "100.101.102.103", "fd7a:115c:a1e0::1234"]);
});

test("extracts Tailscale DNS name and addresses", () => {
  const hosts = hostsFromTailscaleStatus({
    Self: {
      DNSName: "mac-studio.example.ts.net.",
      HostName: "Mac-Studio",
      TailscaleIPs: ["100.64.0.8", "fd7a:115c:a1e0::8"],
    },
  });
  assert.deepEqual(hosts, ["100.64.0.8", "fd7a:115c:a1e0::8", "mac-studio.example.ts.net", "mac-studio"]);
});

test("network allowlist includes machine names, LAN IPs, Tailscale and explicit extras", () => {
  const hosts = buildNetworkAllowedHosts({
    hostname: "Mac-Studio.local",
    interfaces: { en0: [{ address: "10.0.0.55", internal: false }] },
    tailscaleStatus: { Self: { DNSName: "mac-studio.tail.ts.net.", TailscaleIPs: ["100.70.80.90"] } },
    extraHosts: ["career.home"],
  });
  assert.deepEqual(hosts, [
    "10.0.0.55",
    "100.70.80.90",
    "career.home",
    "mac-studio",
    "mac-studio.local",
    "mac-studio.tail.ts.net",
  ]);
});

test("Next dev origins omit IPv6 literals but keep LAN and MagicDNS names", () => {
  assert.deepEqual(
    allowedDevOriginsFromHosts(["192.168.1.42", "mac-studio.local", "fd7a:115c:a1e0::1"]),
    ["192.168.1.42", "mac-studio.local"],
  );
});
