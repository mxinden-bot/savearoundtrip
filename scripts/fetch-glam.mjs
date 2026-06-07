// Fetches the two Happy Eyeballs probes from GLAM's public API (server-side,
// where the browser Same-Origin Policy does not apply) and writes a small
// data/glam.json the static page can read. Run on CI; see .github/workflows/glam.yml.
//
// The GLAM HTTP API is undocumented and meant for GLAM's own frontend, so this
// is best-effort: on any failure we exit non-zero and write nothing, leaving
// the last committed data/glam.json in place.

import { writeFileSync, readFileSync } from "node:fs";

const API = "https://glam.telemetry.mozilla.org/api/v1/data/";
const CHANNEL = "nightly"; // only channel with data for these new probes today
const EXPLORE = (probe, buckets) =>
  `https://glam.telemetry.mozilla.org/fog/probe/${probe}/explore` +
  `?activeBuckets=${encodeURIComponent(JSON.stringify(buckets))}`;

async function fetchProbe(probe) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: {
        product: "fog",
        app_id: CHANNEL,
        os: "*",
        ping_type: "*",
        probe,
        aggregationLevel: "version",
        versions: 20,
      },
    }),
  });
  if (!res.ok) throw new Error(`${probe}: HTTP ${res.status}`);
  const json = await res.json();
  const rows = json.response || [];
  if (!rows.length) throw new Error(`${probe}: no rows`);
  const version = Math.max(...rows.map((r) => r.version));
  const latest = rows.filter((r) => r.version === version);
  // metric_key -> sample_count for the latest version
  const counts = {};
  for (const r of latest) counts[r.metric_key || ""] = r.sample_count || 0;
  return { version, counts };
}

const round = (n) => Math.round(n * 10) / 10;

function shares(counts, labels, denom) {
  const out = {};
  for (const l of labels) out[l] = denom ? round((100 * (counts[l] || 0)) / denom) : 0;
  return out;
}

async function main() {
  const h3 = await fetchProbe("netwerk_happy_eyeballs_h3_discovery");
  const feat = await fetchProbe("netwerk_happy_eyeballs_https_rr_features");

  // h3_discovery: each connection lands in exactly one bucket.
  const c = h3.counts;
  const all = (c.none || 0) + (c.altsvc_only || 0) + (c.both || 0) + (c.https_rr_only || 0);
  const h3capable = (c.altsvc_only || 0) + (c.both || 0) + (c.https_rr_only || 0);

  // https_rr_features: "total" is the denominator (connections with a record).
  const total = feat.counts.total || 0;

  const data = {
    source: "Firefox Nightly, via GLAM",
    channel: CHANNEL,
    fetched_at: new Date().toISOString(),
    h3_discovery: {
      version: h3.version,
      explore_url: EXPLORE("netwerk_happy_eyeballs_h3_discovery", [
        "none",
        "altsvc_only",
        "both",
        "https_rr_only",
      ]),
      // share of all measured connections
      share: shares(c, ["none", "altsvc_only", "both", "https_rr_only"], all),
      // the headline: of h3-capable connections, how many were Alt-Svc-only
      altsvc_only_of_h3_capable: h3capable ? round((100 * (c.altsvc_only || 0)) / h3capable) : 0,
      counts: c,
    },
    https_rr_features: {
      version: feat.version,
      explore_url: EXPLORE("netwerk_happy_eyeballs_https_rr_features", [
        "total",
        "h3_alpn",
        "ipv6hint",
        "ipv4hint",
        "ech",
      ]),
      // each feature as a share of records that were non-empty (the "total" label)
      share_of_records: shares(
        feat.counts,
        ["h3_alpn", "ech", "ipv4hint", "ipv6hint"],
        total
      ),
      counts: feat.counts,
    },
  };

  writeFileSync(new URL("../data/glam.json", import.meta.url), JSON.stringify(data, null, 2) + "\n");
  console.log("wrote data/glam.json");
  console.log("  altsvc_only of h3-capable:", data.h3_discovery.altsvc_only_of_h3_capable + "%");
  console.log("  https records with ECH:", data.https_rr_features.share_of_records.ech + "%");
}

main().catch((e) => {
  console.error("fetch-glam failed, leaving existing data/glam.json untouched:", e.message);
  process.exit(1);
});
