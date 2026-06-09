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

// Sum event counts per label across all rows (build window).
function sumByLabel(rows) {
  const c = {};
  for (const r of rows) c[r.metric_key || ""] = (c[r.metric_key || ""] || 0) + eventCount(r);
  return c;
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

async function main() {
  const h3Builds = await query("netwerk_happy_eyeballs_h3_discovery", "build_id");
  const featBuilds = await query("netwerk_happy_eyeballs_https_rr_features", "build_id");

  // h3 discovery snapshot: event counts summed across the build window
  const hc = sumByLabel(h3Builds);
  const hAll = H3_LABELS.reduce((s, l) => s + (hc[l] || 0), 0);
  const hCap = (hc.altsvc_only || 0) + (hc.both || 0) + (hc.https_rr_only || 0);
  const hVer = Math.max(...h3Builds.map((r) => r.version));
  const series = mergeSeries(readExisting()?.h3_discovery?.series, seriesH3(h3Builds));

  // features snapshot: event counts summed across the build window
  const fc = sumByLabel(featBuilds);
  const fTotal = fc.total || 0;
  const fVer = Math.max(...featBuilds.map((r) => r.version));

  const data = {
    source: "Firefox Nightly, via GLAM (per-connection estimate)",
    channel: CHANNEL,
    approximate: true,
    fetched_at: new Date().toISOString(),
    h3_discovery: {
      version: hVer,
      explore_url: EXPLORE("netwerk_happy_eyeballs_h3_discovery", H3_LABELS),
      share: shares(hc, H3_LABELS, hAll),
      altsvc_only_of_h3_capable: hCap ? round((100 * (hc.altsvc_only || 0)) / hCap) : 0,
      counts: hc,
      series,
    },
    https_rr_features: {
      version: fVer,
      explore_url: EXPLORE("netwerk_happy_eyeballs_https_rr_features", ["total", "h3_alpn", "ipv6hint", "ipv4hint", "ech"]),
      share_of_records: shares(fc, ["h3_alpn", "ech", "ipv4hint", "ipv6hint"], fTotal),
      counts: fc,
    },
  };

  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("wrote data/glam.json");
  console.log("  h3 share:", data.h3_discovery.share);
  console.log("  features:", data.https_rr_features.share_of_records);
  console.log("  series points:", series.length);
}

main().catch((e) => {
  console.error("fetch-glam failed, leaving existing data/glam.json untouched:", e.message);
  process.exit(1);
});
