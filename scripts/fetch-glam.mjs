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

// counts {metric_key: n} -> {label: percent} over the given labels
function shares(counts, labels, denom) {
  const out = {};
  for (const l of labels) out[l] = denom ? round((100 * (counts[l] || 0)) / denom) : 0;
  return out;
}

const H3_LABELS = ["none", "altsvc_only", "both", "https_rr_only"];

// Latest single snapshot from the per-version aggregation (largest sample).
function snapshotH3(rows) {
  const version = Math.max(...rows.map((r) => r.version));
  const counts = {};
  for (const r of rows.filter((r) => r.version === version)) counts[r.metric_key || ""] = r.sample_count || 0;
  const all = H3_LABELS.reduce((s, l) => s + (counts[l] || 0), 0);
  const h3capable = (counts.altsvc_only || 0) + (counts.both || 0) + (counts.https_rr_only || 0);
  return {
    version,
    share: shares(counts, H3_LABELS, all),
    altsvc_only_of_h3_capable: h3capable ? round((100 * (counts.altsvc_only || 0)) / h3capable) : 0,
    counts,
  };
}

// Per-build_id time series of the four-bucket shares.
function seriesH3(rows) {
  const byBuild = {};
  for (const r of rows) {
    const b = r.build_id;
    (byBuild[b] ||= { build_id: b, date: (r.build_date || "").slice(0, 10), counts: {} });
    byBuild[b].counts[r.metric_key || ""] = r.sample_count || 0;
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
  const h3Version = await query("netwerk_happy_eyeballs_h3_discovery", "version");
  const h3Builds = await query("netwerk_happy_eyeballs_h3_discovery", "build_id");
  const featVersion = await query("netwerk_happy_eyeballs_https_rr_features", "version");

  const snap = snapshotH3(h3Version);
  const fresh = seriesH3(h3Builds);
  const prev = readExisting();
  const series = mergeSeries(prev?.h3_discovery?.series, fresh);

  // features snapshot
  const fv = Math.max(...featVersion.map((r) => r.version));
  const fcounts = {};
  for (const r of featVersion.filter((r) => r.version === fv)) fcounts[r.metric_key || ""] = r.sample_count || 0;
  const total = fcounts.total || 0;

  const data = {
    source: "Firefox Nightly, via GLAM",
    channel: CHANNEL,
    fetched_at: new Date().toISOString(),
    h3_discovery: {
      version: snap.version,
      explore_url: EXPLORE("netwerk_happy_eyeballs_h3_discovery", H3_LABELS),
      share: snap.share,
      altsvc_only_of_h3_capable: snap.altsvc_only_of_h3_capable,
      counts: snap.counts,
      series,
    },
    https_rr_features: {
      version: fv,
      explore_url: EXPLORE("netwerk_happy_eyeballs_https_rr_features", ["total", "h3_alpn", "ipv6hint", "ipv4hint", "ech"]),
      share_of_records: shares(fcounts, ["h3_alpn", "ech", "ipv4hint", "ipv6hint"], total),
      counts: fcounts,
    },
  };

  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("wrote data/glam.json");
  console.log("  snapshot shares:", data.h3_discovery.share);
  console.log("  altsvc_only of h3-capable:", data.h3_discovery.altsvc_only_of_h3_capable + "%");
  console.log("  time-series points:", series.length, series.length ? `(${series[0].date} -> ${series.at(-1).date})` : "");
}

main().catch((e) => {
  console.error("fetch-glam failed, leaving existing data/glam.json untouched:", e.message);
  process.exit(1);
});
