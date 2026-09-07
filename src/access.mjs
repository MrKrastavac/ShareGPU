import { timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";

// ------------------------------------------------------------------ addresses

const v4ToBig = (addr) => {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
};

const v6ToBig = (addr) => {
  let text = addr.split("%")[0];
  // An IPv4-mapped tail (::ffff:192.168.0.5) has to be widened to hex first.
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = v4ToBig(tail[1]);
    if (v4 === null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    text = text.slice(0, -tail[1].length) + hi.toString(16) + ":" + lo.toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":").filter(Boolean) : []) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array(fill).fill("0"), ...rest] : head;
  let out = 0n;
  for (const g of groups) {
    const n = Number.parseInt(g, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    out = (out << 16n) | BigInt(n);
  }
  return out;
};

/** Normalise any remote address to { bits, version }. */
export function parseAddress(addr) {
  if (!addr) return null;
  const clean = addr.replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) {
    const bits = v4ToBig(mapped[1]);
    return bits === null ? null : { bits, version: 4, text: mapped[1] };
  }
  if (clean.includes(":")) {
    const bits = v6ToBig(clean);
    return bits === null ? null : { bits, version: 6, text: clean };
  }
  const bits = v4ToBig(clean);
  return bits === null ? null : { bits, version: 4, text: clean };
}

function parseCidr(cidr) {
  const [addr, prefixText] = cidr.split("/");
  const parsed = parseAddress(addr);
  if (!parsed) return null;
  const width = parsed.version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? width : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return null;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix);
  return { network: parsed.bits & mask, mask, version: parsed.version };
}

const allowList = config.allowedNetworks.map(parseCidr).filter(Boolean);

export function isAllowedAddress(remote) {
  const parsed = parseAddress(remote);
  if (!parsed) return false;
  return allowList.some(
    (net) => net.version === parsed.version && (parsed.bits & net.mask) === net.network,
  );
}

// --------------------------------------------------------------------- tokens

export function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerFrom(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return req.headers["x-sharegpu-token"] || null;
}

// --------------------------------------------------------------- rate limiting

const buckets = new Map();

/**
 * Token bucket per client. Refills continuously rather than on a fixed window
 * so a client that paces itself is never punished for a burst it made a minute
 * ago.
 */
export function consumeRate(clientId, cost = 1) {
  const now = Date.now();
  let bucket = buckets.get(clientId);
  if (!bucket) {
    bucket = { tokens: config.rateBurst, last: now };
    buckets.set(clientId, bucket);
  }
  const refill = ((now - bucket.last) / 60_000) * config.ratePerMinute;
  bucket.tokens = Math.min(config.rateBurst, bucket.tokens + refill);
  bucket.last = now;
  if (bucket.tokens < cost) {
    const deficit = cost - bucket.tokens;
    return { ok: false, retryAfter: Math.ceil((deficit / config.ratePerMinute) * 60) };
  }
  bucket.tokens -= cost;
  return { ok: true, remaining: Math.floor(bucket.tokens) };
}

// ------------------------------------------------------------------- identity

const seen = new Map();

/**
 * Clients are identified by source address. A WireGuard peer gets a stable
 * tunnel IP from the router, so this is a real identity on this network in a
 * way it would not be on the open internet.
 */
export function identify(req) {
  const remote = req.socket.remoteAddress || "unknown";
  const parsed = parseAddress(remote);
  const id = parsed?.text ?? remote;
  const name = req.headers["x-sharegpu-client"];
  const record = seen.get(id) ?? { id, firstSeen: Date.now(), requests: 0, name: null };
  record.requests += 1;
  record.lastSeen = Date.now();
  if (typeof name === "string" && name.trim()) record.name = name.trim().slice(0, 64);
  seen.set(id, record);
  // `id` stays the address -- that is the thing rate limits and allow-lists key
  // on, and a client must not be able to rename its way into someone else's
  // bucket. `label` is display only.
  return { ...record, label: record.name ? `${record.name} (${id})` : id };
}

export const knownClients = () => [...seen.values()].sort((a, b) => b.lastSeen - a.lastSeen);

// A refused peer is otherwise invisible, which makes "I cannot reach it from
// the VPN" impossible to tell apart from a firewall drop. Recording the source
// address turns that into a fact: if the address shows up here the packets are
// arriving and the allow-list is wrong; if nothing shows up, they never made it
// past the firewall or the route.
const rejections = new Map();

export function recordRejection(remote, path) {
  const parsed = parseAddress(remote);
  const id = parsed?.text ?? String(remote ?? "unknown");
  const entry = rejections.get(id) ?? { id, first: Date.now(), count: 0, lastPath: null };
  entry.count += 1;
  entry.last = Date.now();
  entry.lastPath = path;
  rejections.set(id, entry);
  // Bound the map so a scanner cannot grow it without limit.
  if (rejections.size > 200) {
    const oldest = [...rejections.values()].sort((a, b) => a.last - b.last)[0];
    if (oldest) rejections.delete(oldest.id);
  }
  return entry;
}

export const recentRejections = () =>
  [...rejections.values()].sort((a, b) => b.last - a.last).slice(0, 25);

/** Suggest the CIDR that would admit a refused address. */
export function suggestNetworkFor(remote) {
  const parsed = parseAddress(remote);
  if (!parsed || parsed.version !== 4) return null;
  const octets = parsed.text.split(".");
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

export const describeAllowList = () => config.allowedNetworks;
