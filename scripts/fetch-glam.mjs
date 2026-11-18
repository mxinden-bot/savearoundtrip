// Fetches Firefox telemetry from GLAM's public API (server-side, where the
// browser Same-Origin Policy does not apply) and writes a small data/glam.json
// the static page can read. Run on CI; see .github/workflows/glam.yml.
//
// Two parts:
// - Firefox NIGHTLY: the two Happy Eyeballs probes (HTTP/3 discovery, HTTPS
//   record features), the only channel carrying them today.
// - Firefox RELEASE: HTTP version share, HTTP/3 round-trip time, connection
//   setup time (TCP + TLS vs QUIC). Each of these is best-effort on its own:
//   on failure the previous value is kept.
//
// The GLAM HTTP API is undocumented and meant for GLAM's own frontend, so this
// is best-effort: on any failure we exit non-zero and write nothing, leaving
// the last committed data/glam.json in place. GLAM only exposes a rolling
// window of build_ids, so we MERGE each run's points into the existing history
// to build a longer time series than GLAM itself keeps.

import { writeFileSync, readFileSync } from "node:fs";

const API = "https://glam.telemetry.mozilla.org/api/v1/data/";
const CHANNEL = "nightly";
const OUT = new URL("../data/glam.json", import.meta.url);
const MAX_POINTS = 200;

const EXPLORE = (probe, buckets) =>
  `https://glam.telemetry.mozilla.org/fog/probe/${probe}/explore` +
  `?activeBuckets=${encodeURIComponent(JSON.stringify(buckets))}`;

async function query(probe, aggregationLevel, app_id = CHANNEL) {
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

// A carried-feature count is always <= the record total in Firefox (metrics.rs
// bumps "total" once per record and each feature at most once). Our per-
// connection counts are reconstructed independently per label from GLAM's
// bucketed histograms, so two near-equal estimates can round to a ratio just
// over 1. Clamp: a share of records can't exceed 100%.
const pct = (num, den) => (den ? Math.min(100, round((100 * num) / den)) : 0);

// Per-connection estimate: GLAM aggregates per client, so sample_count is
// per-client reach (misleading here). Reconstruct an approximate event/
// connection count from the non-normalized histogram: sum bucket_value x
// number_of_clients_in_bucket. Bucketed, so approximate.
function eventCount(rec) {
  const h = rec.non_norm_histogram || {};
  let s = 0;
  for (const k in h) s += parseFloat(k) * h[k];
  return Math.round(s);
}

// counts {metric_key: n} -> {label: percent} over the given labels
function shares(counts, labels, denom) {
  const out = {};
  for (const l of labels) out[l] = denom ? round((100 * (counts[l] || 0)) / denom) : 0;
  return out;
}

const H3_LABELS = ["none", "altsvc_only", "both", "https_rr_only"];

// Per-build feature shares from the dual-labeled `by_resolver` metric. GLAM
// encodes the two labels as "doh[h3_alpn]" / "native[total]" etc. Per build we
// emit: the combined share (doh+native, for the existing chart), each resolver's
// own share, and the doh-vs-native mix of records seen.
const FEATURES = ["h3_alpn", "ech", "ipv4hint", "ipv6hint"];

function featSeries(rows) {
  const byBuild = {};
  for (const r of rows) {
    const b = r.build_id;
    (byBuild[b] ||= { build_id: b, c: {} });
    byBuild[b].c[r.metric_key || ""] = eventCount(r);
  }
  return Object.values(byBuild)
    .sort((a, b) => a.build_id.localeCompare(b.build_id))
    .map(({ c }) => {
      const g = (k) => c[k] || 0;
      const dohT = g("doh[total]");
      const natT = g("native[total]");
      const tot = dohT + natT;
      const o = {};
      for (const f of FEATURES) {
        o[`all_${f}`] = pct(g(`doh[${f}]`) + g(`native[${f}]`), tot);
        o[`doh_${f}`] = pct(g(`doh[${f}]`), dohT);
        o[`native_${f}`] = pct(g(`native[${f}]`), natT);
      }
      o.mix_doh = tot ? round((100 * dohT) / tot) : 0;
      o.mix_native = tot ? round((100 * natT) / tot) : 0;
      return o;
    });
}

// Average the last K points per key. Equal-weights builds, so one outlier
// build's huge event sum can't dominate (the problem with summing across builds).
function avgLast(points, keys, K) {
  const last = points.slice(-K);
  const out = {};
  for (const k of keys) {
    const vals = last.map((p) => p[k] || 0);
    out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return out;
}

// Per-build_id time series of the four-bucket shares.
function seriesH3(rows) {
  const byBuild = {};
  for (const r of rows) {
    const b = r.build_id;
    (byBuild[b] ||= { build_id: b, date: (r.build_date || "").slice(0, 10), counts: {} });
    byBuild[b].counts[r.metric_key || ""] = eventCount(r);
  }
  return Object.values(byBuild)
    .map(({ build_id, date, counts }) => {
      const all = H3_LABELS.reduce((s, l) => s + (counts[l] || 0), 0);
      return { build_id, date, ...shares(counts, H3_LABELS, all) };
    })
    .sort((a, b) => a.build_id.localeCompare(b.build_id));
}

function mergeSeries(existing, fresh) {
  const map = new Map((existing || []).map((p) => [p.build_id, p]));
  for (const p of fresh) map.set(p.build_id, p); // fresh values win
  return [...map.values()].sort((a, b) => a.build_id.localeCompare(b.build_id)).slice(-MAX_POINTS);
}

function readExisting() {
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return null;
  }
}

const SMOOTH = 14; // build points to average (~1 week of Nightly)

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
  const FEAT_PROBE = "netwerk_happy_eyeballs_https_rr_features_by_resolver";
  const h3Builds = await query("netwerk_happy_eyeballs_h3_discovery", "build_id");
  const featBuilds = await query(FEAT_PROBE, "build_id");

  const prev = readExisting();
  const h3pts = seriesH3(h3Builds);
  const series = mergeSeries(prev?.h3_discovery?.series, h3pts);

  // headline: average recent per-build shares (renormalized to 100), so one
  // heavy build can't dominate the way a cross-build event sum did
  const hAvg = avgLast(h3pts, H3_LABELS, SMOOTH);
  const hSum = H3_LABELS.reduce((s, l) => s + hAvg[l], 0);

  // netwerk.happy_eyeballs.h3_discovery stopped landing in GLAM after a June-24
  // Firefox metric change (Bug 2047587). If a refresh has no signal, keep the
  // last-known-good block rather than publish a bogus 0%.
  let h3_discovery;
  if (hSum > 0) {
    const hShare = {};
    for (const l of H3_LABELS) hShare[l] = round((100 * hAvg[l]) / hSum);
    const cap = hShare.altsvc_only + hShare.both + hShare.https_rr_only;
    h3_discovery = {
      version: Math.max(...h3Builds.map((r) => r.version)),
      explore_url: EXPLORE("netwerk_happy_eyeballs_h3_discovery", H3_LABELS),
      share: hShare,
      altsvc_only_of_h3_capable: cap ? round((100 * hShare.altsvc_only) / cap) : 0,
      series,
    };
  } else if (prev?.h3_discovery) {
    h3_discovery = { ...prev.h3_discovery, series };
    console.warn("  h3_discovery: no fresh signal, kept last-known-good");
  } else {
    h3_discovery = {
      version: 0,
      explore_url: EXPLORE("netwerk_happy_eyeballs_h3_discovery", H3_LABELS),
      share: { none: 0, altsvc_only: 0, both: 0, https_rr_only: 0 },
      altsvc_only_of_h3_capable: 0,
      series,
    };
  }

  const featKeys = ["mix_doh", "mix_native"];
  for (const f of FEATURES) featKeys.push(`all_${f}`, `doh_${f}`, `native_${f}`);
  const fAvg = avgLast(featSeries(featBuilds), featKeys, SMOOTH);
  const fShare = {};
  const byDoh = {};
  const byNative = {};
  for (const f of FEATURES) {
    fShare[f] = round(fAvg[`all_${f}`]);
    byDoh[f] = round(fAvg[`doh_${f}`]);
    byNative[f] = round(fAvg[`native_${f}`]);
  }

  const release = await fetchRelease(prev?.release);

  const data = {
    source: "Firefox Nightly, via GLAM (per-connection estimate)",
    channel: CHANNEL,
    approximate: true,
    fetched_at: new Date().toISOString(),
    release,
    h3_discovery,
    https_rr_features: {
      version: Math.max(...featBuilds.map((r) => r.version)),
      explore_url: EXPLORE(FEAT_PROBE, ["doh[total]", "native[total]", "doh[h3_alpn]", "native[h3_alpn]"]),
      share_of_records: fShare,
      by_resolver: {
        doh: byDoh,
        native: byNative,
        mix: { doh: round(fAvg.mix_doh), native: round(fAvg.mix_native) },
      },
    },
  };

  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("wrote data/glam.json");
  console.log("  h3 share:", data.h3_discovery.share, "(altsvc_only headline)");
  console.log("  features:", data.https_rr_features.share_of_records);
  console.log("  series points:", series.length);
  console.log("  release:", JSON.stringify(release));
}

main().catch((e) => {
  console.error("fetch-glam failed, leaving existing data/glam.json untouched:", e.message);
  process.exit(1);
});
