// Fetches Firefox telemetry from GLAM's public API (server-side, where the
// browser Same-Origin Policy does not apply) and writes a small data/glam.json
// the static page can read. Run on CI; see .github/workflows/glam.yml.
//
// Firefox RELEASE: HTTP version share by version, HTTP/3 round-trip time and
// connection setup time (TCP + TLS vs QUIC), both per connection. Each is
// best-effort on its own: on failure the previous value is kept.
//
// The GLAM HTTP API is undocumented and meant for GLAM's own frontend. If
// nothing can be fetched and there is no previous data, we exit non-zero and
// write nothing, leaving the last committed data/glam.json in place.

import { writeFileSync, readFileSync } from "node:fs";

const API = "https://glam.telemetry.mozilla.org/api/v1/data/";
const OUT = new URL("../data/glam.json", import.meta.url);

async function query(probe, aggregationLevel, app_id = "release") {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: { product: "fog", app_id, os: "*", ping_type: "*", probe, aggregationLevel, versions: 20 },
    }),
  });
  if (!res.ok) throw new Error(`${probe} (${aggregationLevel}): HTTP ${res.status}`);
  const json = await res.json();
  const rows = json.response || [];
  if (!rows.length) throw new Error(`${probe} (${aggregationLevel}): no rows`);
  return rows;
}

const round = (n) => Math.round(n * 10) / 10;

function readExisting() {
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return null;
  }
}

/* ---- Firefox Release ---- */

const RELEASE_VERSIONS = 8;

// One clean row per version. GLAM also returns stray rows for older versions
// whose histograms are keyed by numeric buckets, not labels; drop those.
function labeledByVersion(rows, metricKey = "") {
  const out = new Map();
  for (const r of rows) {
    if ((r.metric_key || "") !== metricKey) continue;
    const keys = Object.keys(r.non_norm_histogram || {});
    if (!keys.length || keys.every((k) => !isNaN(parseFloat(k)))) continue;
    out.set(r.version, r);
  }
  return out;
}

// Versions to report: the newest is dropped while it is still rolling out
// (fewer than half the users of the version before it), as on the slides.
function settledVersions(byVersion) {
  const vs = [...byVersion.keys()].sort((a, b) => a - b);
  const last = vs.length - 1;
  if (last > 0 && byVersion.get(vs[last]).total_users < 0.5 * byVersion.get(vs[last - 1]).total_users) vs.pop();
  return vs.slice(-RELEASE_VERSIONS);
}

// Per-request share of each label: GLAM's non-normalized histogram counts
// every request, so this matches what Firefox actually sent.
function labelShares(row) {
  const h = row.non_norm_histogram;
  const tot = Object.values(h).reduce((a, b) => a + b, 0);
  return (label) => (tot ? round((100 * (h[label] || 0)) / tot) : 0);
}

async function releaseHttpVersion() {
  const byV = labeledByVersion(await query("networking_http_response_version", "version", "release"));
  const vs = settledVersions(byV);
  const sh = vs.map((v) => labelShares(byV.get(v)));
  return {
    versions: vs.map(String),
    h1: sh.map((s) => s("http_1")),
    h2: sh.map((s) => s("http_2")),
    h3: sh.map((s) => s("http_3")),
  };
}

// Percentiles of a (labeled) distribution for the newest settled version.
// HTTP/3 round-trip time pooled over all connections (GLAM's non-normalized
// histogram), as a cumulative curve: the share of connections at or below each
// bucket's upper bound, in ms. Percentiles are read off the same curve.
async function releaseRttCdf() {
  const rows = (await query("networking_http_3_rtt", "version", "release")).filter((r) => !r.metric_key && r.non_norm_histogram);
  const byV = new Map(rows.map((r) => [r.version, r]));
  const v = settledVersions(byV).pop();
  const h = byV.get(v).non_norm_histogram;
  const ks = Object.keys(h).map(Number).sort((a, b) => a - b);
  const tot = ks.reduce((t, k) => t + h[k], 0);
  let c = 0;
  const cdf = [];
  ks.forEach((k, i) => {
    c += h[k];
    if (i + 1 < ks.length) cdf.push([ks[i + 1], Math.round((10000 * c) / tot) / 100]);
  });
  const at = (q) => (cdf.find((p) => p[1] >= q) || cdf[cdf.length - 1])[0];
  return { version: String(v), p50: at(50), p75: at(75), p95: at(95), p99: at(99), cdf };
}

// Connection setup time to servers that speak HTTP/3, desktop page loads,
// pooled over connections: TCP + TLS for HTTP/2 vs the QUIC handshake for
// HTTP/3, each as a cumulative curve [upper bound in ms, share %] (ns -> ms).
async function releaseSetupCdf() {
  const curve = async (probe, key) => {
    const rows = (await query(probe, "version", "release")).filter((r) => r.metric_key === key && r.non_norm_histogram);
    const byV = new Map(rows.map((r) => [r.version, r]));
    const v = settledVersions(byV).pop();
    const h = byV.get(v).non_norm_histogram;
    const ks = Object.keys(h).map(Number).sort((a, b) => a - b);
    const tot = ks.reduce((t, k) => t + h[k], 0);
    let c = 0;
    const cdf = [];
    ks.forEach((k, i) => {
      c += h[k];
      if (i + 1 < ks.length) cdf.push([Math.round(ks[i + 1] / 1e4) / 100, Math.round((10000 * c) / tot) / 100]);
    });
    const at = (q) => (cdf.find((p) => p[1] >= q) || cdf[cdf.length - 1])[0];
    return { version: String(v), p50: at(50), p95: at(95), cdf: cdf.filter(([ms]) => ms >= 1 && ms <= 6000) };
  };
  const tcp = await curve("network_sup_http3_tcp_connection", "supports_http3_page");
  const quic = await curve("network_http3_tls_handshake", "uses_http3_page");
  return { version: tcp.version, tcp, quic };
}

async function fetchRelease(prev) {
  const out = {};
  const tasks = {
    http_version: () => releaseHttpVersion(),
    // HTTP/3 round-trip time per connection, in ms
    rtt: () => releaseRttCdf(),
    // connection setup to servers that speak HTTP/3, page loads: TCP + TLS for
    // HTTP/2 vs the QUIC handshake for HTTP/3, per connection
    setup_cdf: () => releaseSetupCdf(),
  };
  for (const [k, fn] of Object.entries(tasks)) {
    try {
      out[k] = await fn();
    } catch (e) {
      if (prev?.[k]) out[k] = prev[k];
      console.warn(`  release.${k}: ${e.message}, kept previous value`);
    }
  }
  return out;
}

async function main() {
  const prev = readExisting();
  const release = await fetchRelease(prev?.release);
  if (!Object.keys(release).length) throw new Error("no Firefox Release data from GLAM");
  const data = {
    source: "Firefox Release, via GLAM",
    fetched_at: new Date().toISOString(),
    release,
  };
  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("wrote data/glam.json");
  console.log("  release:", Object.keys(release).join(", "));
}

main().catch((e) => {
  console.error("fetch-glam failed, leaving existing data/glam.json untouched:", e.message);
  process.exit(1);
});
