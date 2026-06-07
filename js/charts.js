/* Renders the real-browser numbers from data/glam.json (refreshed on CI from
 * GLAM; see scripts/fetch-glam.mjs). Same-origin static file, so no CORS. */

function barRow(label, pct, kind) {
  const row = document.createElement("div");
  row.className = "bar-row";
  const w = Math.max(0, Math.min(100, pct));
  row.innerHTML =
    `<span class="bar-label">${label}</span>` +
    `<span class="bar-track"><span class="bar-fill ${kind}" style="width:${w}%"></span></span>` +
    `<span class="bar-val">${pct}%</span>`;
  return row;
}

function renderBars(el, rows) {
  el.innerHTML = "";
  for (const [label, pct, kind] of rows) el.append(barRow(label, pct, kind));
}

async function loadGlam() {
  const section = document.getElementById("data");
  const metricNum = document.getElementById("metric-num");
  const metricSrc = document.getElementById("metric-src");

  let d;
  try {
    const r = await fetch("data/glam.json", { cache: "no-store" });
    if (!r.ok) throw new Error("no glam.json");
    d = await r.json();
  } catch (e) {
    if (metricNum) {
      metricNum.textContent = "??%";
      metricNum.classList.remove("loading");
    }
    if (section) section.hidden = true;
    return;
  }

  // Headline: of h3-capable connections, the share that were Alt-Svc-only.
  const headline = d.h3_discovery.altsvc_only_of_h3_capable;
  if (metricNum) {
    metricNum.textContent = headline + "%";
    metricNum.classList.remove("loading");
  }
  const when = (d.fetched_at || "").slice(0, 10);
  if (metricSrc) {
    metricSrc.innerHTML =
      `Firefox Nightly v${d.h3_discovery.version}, via ` +
      `<a href="${d.h3_discovery.explore_url}">GLAM</a>. updated ${when}.`;
  }

  // h3 discovery breakdown
  const h3 = d.h3_discovery.share;
  const chartH3 = document.getElementById("chart-h3");
  if (chartH3) {
    renderBars(chartH3, [
      ["none", h3.none, ""],
      ["altsvc_only", h3.altsvc_only, "gap"],
      ["both", h3.both, "good"],
      ["https_rr_only", h3.https_rr_only, "good"],
    ]);
  }

  // https record features
  const f = d.https_rr_features.share_of_records;
  const chartFeat = document.getElementById("chart-feat");
  if (chartFeat) {
    renderBars(chartFeat, [
      ["h3 in ALPN", f.h3_alpn, "good"],
      ["IPv4 hint", f.ipv4hint, "info"],
      ["IPv6 hint", f.ipv6hint, "info"],
      ["ECH", f.ech, "info"],
    ]);
  }

  const src = document.getElementById("data-src");
  if (src) {
    src.innerHTML =
      `source: Firefox Nightly v${d.h3_discovery.version}, via GLAM, updated ${when}. ` +
      `Explore: <a href="${d.h3_discovery.explore_url}">h3 discovery</a>, ` +
      `<a href="${d.https_rr_features.explore_url}">HTTPS record features</a>. ` +
      `Shares are GLAM's per-client aggregation.`;
  }
}

document.addEventListener("DOMContentLoaded", loadGlam);
