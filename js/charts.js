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

function barRow(label, pct, cls) {
  const w = Math.max(0, Math.min(100, pct));
  return elem(
    "div",
    "bar-row",
    `<span class="bar-label">${label}</span>` +
      `<span class="bar-track"><span class="bar-fill ${cls}" style="width:${w}%"></span></span>` +
      `<span class="bar-val">${pct}%</span>`
  );
}

function renderBars(el, rows) {
  el.innerHTML = "";
  for (const [label, pct, cls] of rows) el.append(barRow(label, pct, cls));
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

  const W = 720, H = 220, padL = 6, padR = 6, padT = 8, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = pts.length;
  const x = (i) => padL + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (cum) => padT + ((100 - cum) / 100) * plotH;

  // cumulative tops per point
  const cum = pts.map((p) => {
    const c = [0];
    for (const k of STACK) c.push(c[c.length - 1] + (p[k] || 0));
    return c;
  });

  let paths = "";
  const bandClass = { none: "band-none", altsvc_only: "band-altsvc", both: "band-both", https_rr_only: "band-https" };
  STACK.forEach((k, b) => {
    const top = pts.map((_, i) => `${x(i).toFixed(1)},${y(cum[i][b + 1]).toFixed(1)}`);
    const bot = pts.map((_, i) => `${x(i).toFixed(1)},${y(cum[i][b]).toFixed(1)}`).reverse();
    paths += `<path class="${bandClass[k]}" d="M${top.join(" L")} L${bot.join(" L")} Z"></path>`;
  });

  const first = pts[0].date, last = pts[n - 1].date;
  const svg =
    `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
    `aria-label="Stacked share of the four HTTP/3 discovery groups over recent Firefox Nightly builds">` +
    paths +
    `<text class="ax" x="${padL}" y="${H - 8}">${first}</text>` +
    `<text class="ax" x="${W - padR}" y="${H - 8}" text-anchor="end">${last}</text>` +
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
  const stats = document.getElementById("stats-h3");
  if (stats) renderStats(stats, share);

  const chartH3 = document.getElementById("chart-h3");
  if (chartH3) {
    renderBars(chartH3, [
      [BUCKETS.none[0], share.none, "c-none"],
      [BUCKETS.altsvc_only[0], share.altsvc_only, "c-altsvc"],
      [BUCKETS.https_rr_only[0], share.https_rr_only, "c-https"],
      [BUCKETS.both[0], share.both, "c-both"],
    ]);
  }

  const trend = document.getElementById("chart-trend");
  if (trend) renderTrend(trend, d.h3_discovery.series);

  const f = d.https_rr_features.share_of_records;
  const chartFeat = document.getElementById("chart-feat");
  if (chartFeat) {
    renderBars(chartFeat, [
      ["h3 in ALPN", f.h3_alpn, "c-https"],
      ["IPv4 hint", f.ipv4hint, "c-both"],
      ["IPv6 hint", f.ipv6hint, "c-both"],
      ["ECH", f.ech, "c-both"],
    ]);
  }

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
