/* Renders the real-browser numbers from data/glam.json (refreshed on CI from
 * GLAM; see scripts/fetch-glam.mjs). Same-origin static file, so no CORS.
 *
 * Shares are GLAM's "By Client ID" proportion: sample_count[bucket] divided by
 * the sum over buckets, per build. That matches what the GLAM UI shows. */

// bucket key -> [friendly label, color class]
const BUCKETS = {
  none: ["Neither", "c-none"],
  altsvc_only: ["Alt-Svc only", "c-altsvc"],
  https_rr_only: ["HTTPS record only", "c-https"],
  both: ["Both", "c-both"],
};
// stack order, bottom to top, for the time series
const STACK = ["none", "altsvc_only", "both", "https_rr_only"];

function elem(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function renderStats(el, share) {
  el.innerHTML = "";
  for (const k of ["none", "altsvc_only", "https_rr_only", "both"]) {
    const [label, c] = BUCKETS[k];
    const cell = elem("div", "stat");
    cell.append(elem("div", `n ${c}`, (share[k] ?? 0) + "%"));
    cell.append(elem("div", "l", label));
    el.append(cell);
  }
}

const fmt = (n) => Number(n || 0).toLocaleString("en-US");

function barRow(label, pct, cls, count) {
  const w = Math.max(0, Math.min(100, pct));
  const title = count != null ? ` title="${fmt(count)} samples"` : "";
  return elem(
    "div",
    "bar-row",
    `<span class="bar-label">${label}</span>` +
      `<span class="bar-track"${title}><span class="bar-fill ${cls}" style="width:${w}%"></span></span>` +
      `<span class="bar-val">${pct}%</span>`
  );
}

function renderBars(el, rows) {
  el.innerHTML = "";
  for (const [label, pct, cls, count] of rows) el.append(barRow(label, pct, cls, count));
}

// 100% stacked area of the four buckets over time.
function renderTrend(el, series) {
  el.innerHTML = "";
  const pts = (series || []).filter((p) => STACK.reduce((s, k) => s + (p[k] || 0), 0) > 0);
  if (pts.length < 2) {
    el.append(
      elem("p", "chart-cap", "Collecting data: the trend appears after a few more Nightly builds.")
    );
    return;
  }

  const W = 720, H = 200, padL = 6, padR = 6, padT = 8, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = pts.length;
  const slot = plotW / n;
  const barW = Math.min(30, slot * 0.68);
  const yTop = (cum) => padT + ((100 - cum) / 100) * plotH;
  const bandClass = { none: "band-none", altsvc_only: "band-altsvc", both: "band-both", https_rr_only: "band-https" };

  // one slim stacked column per build
  let rects = "";
  pts.forEach((p, i) => {
    const x = padL + slot * (i + 0.5) - barW / 2;
    let cum = 0;
    for (const k of STACK) {
      const v = p[k] || 0;
      const y0 = yTop(cum + v), h = Math.max(0, yTop(cum) - y0);
      rects += `<rect class="${bandClass[k]}" x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1"><title>${p.date} ${BUCKETS[k][0]}: ${v}%</title></rect>`;
      cum += v;
    }
  });

  const first = pts[0].date, last = pts[n - 1].date;
  const svg =
    `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="Share of the four HTTP/3 discovery groups per recent Firefox Nightly build, stacked to 100%">` +
    rects +
    `<text class="ax" x="${padL}" y="${H - 6}">${first}</text>` +
    `<text class="ax" x="${W - padR}" y="${H - 6}" text-anchor="end">${last}</text>` +
    `</svg>`;

  const legend = elem("div", "legend");
  for (const k of STACK) {
    const [label, c] = BUCKETS[k];
    legend.append(elem("span", "legend-item", `<span class="legend-dot ${c}"></span>${label}`));
  }

  el.append(elem("div", "trend", svg));
  el.append(legend);
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
  } catch {
    if (metricNum) {
      metricNum.textContent = "??%";
      metricNum.classList.remove("loading");
    }
    if (section) section.hidden = true;
    return;
  }

  const when = (d.fetched_at || "").slice(0, 10);

  // headline number
  if (metricNum) {
    metricNum.textContent = d.h3_discovery.altsvc_only_of_h3_capable + "%";
    metricNum.classList.remove("loading");
  }
  if (metricSrc) {
    metricSrc.innerHTML =
      `Firefox Nightly v${d.h3_discovery.version}, via ` +
      `<a href="${d.h3_discovery.explore_url}">GLAM</a>. updated ${when}.`;
  }

  const share = d.h3_discovery.share;
  const hc = d.h3_discovery.counts || {};
  const stats = document.getElementById("stats-h3");
  if (stats) renderStats(stats, share);

  const chartH3 = document.getElementById("chart-h3");
  if (chartH3) {
    renderBars(chartH3, [
      [BUCKETS.none[0], share.none, "c-none", hc.none],
      [BUCKETS.altsvc_only[0], share.altsvc_only, "c-altsvc", hc.altsvc_only],
      [BUCKETS.https_rr_only[0], share.https_rr_only, "c-https", hc.https_rr_only],
      [BUCKETS.both[0], share.both, "c-both", hc.both],
    ]);
  }
  const h3n = document.getElementById("h3-n");
  if (h3n) {
    const total = (hc.none || 0) + (hc.altsvc_only || 0) + (hc.https_rr_only || 0) + (hc.both || 0);
    h3n.textContent = `Based on ${fmt(total)} samples.`;
  }

  const trend = document.getElementById("chart-trend");
  if (trend) renderTrend(trend, d.h3_discovery.series);

  const f = d.https_rr_features.share_of_records;
  const fc = d.https_rr_features.counts || {};
  const chartFeat = document.getElementById("chart-feat");
  if (chartFeat) {
    renderBars(chartFeat, [
      ["h3 in ALPN", f.h3_alpn, "c-https", fc.h3_alpn],
      ["IPv4 hint", f.ipv4hint, "c-both", fc.ipv4hint],
      ["IPv6 hint", f.ipv6hint, "c-both", fc.ipv6hint],
      ["ECH", f.ech, "c-both", fc.ech],
    ]);
  }
  const featN = document.getElementById("feat-n");
  if (featN) featN.textContent = `Based on ${fmt(fc.total)} connections that saw an HTTPS record.`;

  const src = document.getElementById("data-src");
  if (src) {
    src.innerHTML =
      `Source: Firefox Nightly v${d.h3_discovery.version}, via GLAM, updated ${when}. ` +
      `Explore: <a href="${d.h3_discovery.explore_url}">h3 discovery</a>, ` +
      `<a href="${d.https_rr_features.explore_url}">HTTPS record features</a>. ` +
      `Shares use GLAM's By Client ID normalization.`;
  }
}

document.addEventListener("DOMContentLoaded", loadGlam);
