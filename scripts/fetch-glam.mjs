// Fetches the two Happy Eyeballs probes from GLAM's public API (server-side,
// where the browser Same-Origin Policy does not apply) and writes a small
// data/glam.json the static page can read. Run on CI; see .github/workflows/glam.yml.
//
// Firefox NIGHTLY only: that is the only channel carrying these probes today.
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

async function query(probe, aggregationLevel) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: { product: "fog", app_id: CHANNEL, os: "*", ping_type: "*", probe, aggregationLevel, versions: 20 },
    }),
  });
  if (!res.ok) throw new Error(`${probe} (${aggregationLevel}): HTTP ${res.status}`);
  const json = await res.json();
  const rows = json.response || [];
  if (!rows.length) throw new Error(`${probe} (${aggregationLevel}): no rows`);
  return rows;
}

const round = (n) => Math.round(n * 10) / 10;

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

// Per-build feature shares (each feature vs the "total" label), event-estimated.
function featSeries(rows) {
  const byBuild = {};
  for (const r of rows) {
    const b = r.build_id;
    (byBuild[b] ||= { build_id: b, c: {} });
    byBuild[b].c[r.metric_key || ""] = eventCount(r);
  }
  const F = ["h3_alpn", "ech", "ipv4hint", "ipv6hint"];
  return Object.values(byBuild)
    .sort((a, b) => a.build_id.localeCompare(b.build_id))
    .map(({ c }) => {
      const t = c.total || 0;
      const o = {};
      for (const l of F) o[l] = t ? round((100 * (c[l] || 0)) / t) : 0;
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

async function main() {
  const h3Builds = await query("netwerk_happy_eyeballs_h3_discovery", "build_id");
  const featBuilds = await query("netwerk_happy_eyeballs_https_rr_features", "build_id");

  const h3pts = seriesH3(h3Builds);
  const series = mergeSeries(readExisting()?.h3_discovery?.series, h3pts);

  // headline: average recent per-build shares (renormalized to 100), so one
  // heavy build can't dominate the way a cross-build event sum did
  const hAvg = avgLast(h3pts, H3_LABELS, SMOOTH);
  const hSum = H3_LABELS.reduce((s, l) => s + hAvg[l], 0) || 1;
  const hShare = {};
  for (const l of H3_LABELS) hShare[l] = round((100 * hAvg[l]) / hSum);
  const cap = hShare.altsvc_only + hShare.both + hShare.https_rr_only;

  const fAvg = avgLast(featSeries(featBuilds), ["h3_alpn", "ech", "ipv4hint", "ipv6hint"], SMOOTH);
  const fShare = {};
  for (const k in fAvg) fShare[k] = round(fAvg[k]);

  const data = {
    source: "Firefox Nightly, via GLAM (per-connection estimate)",
    channel: CHANNEL,
    approximate: true,
    fetched_at: new Date().toISOString(),
    h3_discovery: {
      version: Math.max(...h3Builds.map((r) => r.version)),
      explore_url: EXPLORE("netwerk_happy_eyeballs_h3_discovery", H3_LABELS),
      share: hShare,
      altsvc_only_of_h3_capable: cap ? round((100 * hShare.altsvc_only) / cap) : 0,
      series,
    },
    https_rr_features: {
      version: Math.max(...featBuilds.map((r) => r.version)),
      explore_url: EXPLORE("netwerk_happy_eyeballs_https_rr_features", ["total", "h3_alpn", "ipv6hint", "ipv4hint", "ech"]),
      share_of_records: fShare,
    },
  };

  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("wrote data/glam.json");
  console.log("  h3 share:", data.h3_discovery.share, "(altsvc_only headline)");
  console.log("  features:", data.https_rr_features.share_of_records);
  console.log("  series points:", series.length);
}

main().catch((e) => {
  console.error("fetch-glam failed, leaving existing data/glam.json untouched:", e.message);
  process.exit(1);
});
