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
        o[`all_${f}`] = tot ? round((100 * (g(`doh[${f}]`) + g(`native[${f}]`))) / tot) : 0;
        o[`doh_${f}`] = dohT ? round((100 * g(`doh[${f}]`)) / dohT) : 0;
        o[`native_${f}`] = natT ? round((100 * g(`native[${f}]`)) / natT) : 0;
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

  const data = {
    source: "Firefox Nightly, via GLAM (per-connection estimate)",
    channel: CHANNEL,
    approximate: true,
    fetched_at: new Date().toISOString(),
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
}

main().catch((e) => {
  console.error("fetch-glam failed, leaving existing data/glam.json untouched:", e.message);
  process.exit(1);
});
