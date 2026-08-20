function cleanHost(value) {
  if (!value) return "";
  let host = String(value).trim().toLowerCase();
  if (!host) return "";
  if (host.endsWith(".")) host = host.slice(0, -1);
  // Node may expose link-local IPv6 addresses with a scope suffix (%en0).
  const scope = host.indexOf("%");
  if (scope !== -1) host = host.slice(0, scope);
  // Strip a port from simple host:port values. Leave bare IPv6 literals alone.
  const firstColon = host.indexOf(":");
  if (firstColon !== -1 && host.indexOf(":", firstColon + 1) === -1) {
    host = host.slice(0, firstColon);
  }
  return host;
}

export function parseExtraHosts(value) {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map(cleanHost)
    .filter(Boolean);
}

export function hostsFromInterfaces(interfaces = {}) {
  const hosts = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal || !entry.address) continue;
      const host = cleanHost(entry.address);
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

export function hostsFromTailscaleStatus(status) {
  const self = status?.Self ?? {};
  const hosts = [];
  for (const ip of self.TailscaleIPs ?? []) {
    const host = cleanHost(ip);
    if (host) hosts.push(host);
  }
  for (const candidate of [self.DNSName, self.HostName]) {
    const host = cleanHost(candidate);
    if (host) hosts.push(host);
  }
  return hosts;
}

export function buildNetworkAllowedHosts({
  hostname = "",
  interfaces = {},
  tailscaleStatus = null,
  extraHosts = [],
} = {}) {
  const out = new Set();
  const machine = cleanHost(hostname);
  if (machine) {
    out.add(machine);
    const short = machine.split(".")[0];
    if (short) {
      out.add(short);
      out.add(`${short}.local`);
    }
  }
  for (const host of hostsFromInterfaces(interfaces)) out.add(host);
  for (const host of hostsFromTailscaleStatus(tailscaleStatus)) out.add(host);
  for (const host of extraHosts) {
    const clean = cleanHost(host);
    if (clean) out.add(clean);
  }
  return [...out].sort();
}

// Next's development-origin option takes host patterns rather than URLs.
// IPv6 literals are omitted here because they contain ':'; production access is
// still allowed by the API origin guard and the network launcher.
export function allowedDevOriginsFromHosts(hosts = []) {
  return hosts.filter((host) => host && !host.includes(":"));
}
