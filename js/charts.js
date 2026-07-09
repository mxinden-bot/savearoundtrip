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

  const W = 720, H = 214, padL = 8, padR = 8, padT = 8, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = pts.length;
  const slot = plotW / n;
  const barW = Math.min(26, slot * 0.6);
  const yTop = (cum) => padT + ((100 - cum) / 100) * plotH;
  const bandClass = { none: "band-none", altsvc_only: "band-altsvc", both: "band-both", https_rr_only: "band-https" };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortDate = (d) => {
    const [, m, day] = (d || "").split("-");
    return m ? `${MON[+m - 1]} ${+day}` : d;
  };

  // one slim stacked column per build
  let rects = "";
  pts.forEach((p, i) => {
    const x = padL + slot * (i + 0.5) - barW / 2;
    let cum = 0;
    for (const k of STACK) {
      const v = p[k] || 0;
      const y0 = yTop(cum + v), h = Math.max(0, yTop(cum) - y0);
      rects += `<rect class="${bandClass[k]}" x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1"></rect>`;
      cum += v;
    }
  });
  // tilted date label under the first bar of each day, thinned to ~14 max
  const isDayStart = pts.map((p, i) => i === 0 || pts[i - 1].date !== p.date);
  const dayTotal = isDayStart.filter(Boolean).length;
  const step = Math.ceil(dayTotal / 14);
  let ticks = "", dayIdx = -1;
  pts.forEach((p, i) => {
    if (!isDayStart[i]) return;
    dayIdx += 1;
    if (dayIdx % step !== 0) return;
    const cx = padL + slot * (i + 0.5);
    const ty = H - padB + 15;
    ticks += `<text class="ax" transform="rotate(-40 ${cx.toFixed(1)} ${ty})" x="${cx.toFixed(1)}" y="${ty}" text-anchor="end">${shortDate(p.date)}</text>`;
  });
  // one transparent hover target per build, spanning the whole column slot
  let hits = "";
  pts.forEach((_, i) => {
    hits += `<rect class="hit" data-i="${i}" x="${(padL + slot * i).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}"></rect>`;
  });

  const svg =
    `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="Share of the four HTTP/3 discovery groups per recent Firefox Nightly build, stacked to 100%">` +
    rects +
    hits +
    ticks +
    `</svg>`;

  const wrap = elem("div", "trend");
  wrap.innerHTML = svg;
  const tip = elem("div", "trend-tip");
  tip.hidden = true;
  wrap.append(tip);

  const order = ["none", "altsvc_only", "https_rr_only", "both"];
  wrap.querySelectorAll("rect.hit").forEach((r) => {
    const i = Number(r.getAttribute("data-i"));
    const move = (e) => {
      const p = pts[i];
      tip.hidden = false;
      tip.innerHTML =
        `<div class="tip-date">${p.date}</div>` +
        order
          .map(
            (k) =>
              `<div class="tip-row"><span class="tip-dot ${BUCKETS[k][1]}"></span>` +
              `${BUCKETS[k][0]}<span class="tip-v">${p[k] || 0}%</span></div>`
          )
          .join("");
      const box = wrap.getBoundingClientRect();
      let lx = e.clientX - box.left + 14;
      if (lx + 170 > box.width) lx = e.clientX - box.left - 170;
      tip.style.left = Math.max(4, lx) + "px";
      tip.style.top = Math.max(4, e.clientY - box.top + 12) + "px";
    };
    r.addEventListener("mouseenter", move);
    r.addEventListener("mousemove", move);
    r.addEventListener("mouseleave", () => {
      tip.hidden = true;
    });
  });

  const legend = elem("div", "legend");
  for (const k of STACK) {
    const [label, c] = BUCKETS[k];
    legend.append(elem("span", "legend-item", `<span class="legend-dot ${c}"></span>${label}`));
  }

  el.append(wrap);
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
    metricNum.textContent = d.h3_discovery.share.altsvc_only + "%";
    metricNum.classList.remove("loading");
  }
  if (metricSrc) {
    metricSrc.innerHTML =
      `Firefox Nightly, via <a href="${d.h3_discovery.explore_url}">GLAM</a>, updated ${when}. ` +
      `Approximate per-connection estimate, averaged over recent builds.`;
  }

  const share = d.h3_discovery.share;
  const hc = d.h3_discovery.counts || {};
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

  const br = d.https_rr_features.by_resolver;
  const mixEl = document.getElementById("resolver-mix");
  if (mixEl && br) {
    mixEl.innerHTML =
      `Of the records Firefox saw, <b>${br.mix.doh}%</b> came via DoH and ` +
      `<b>${br.mix.native}%</b> via the native resolver. Share of each carrying:`;
  }
  const featRes = document.getElementById("chart-feat-resolver");
  if (featRes && br) {
    const rows = [
      ["h3 in ALPN", "h3_alpn"],
      ["IPv4 hint", "ipv4hint"],
      ["IPv6 hint", "ipv6hint"],
      ["ECH", "ech"],
    ];
    featRes.innerHTML =
      `<table class="cmp"><thead><tr><th>feature</th><th>DoH</th><th>native</th></tr></thead><tbody>` +
      rows
        .map(([label, k]) => `<tr><td>${label}</td><td>${br.doh[k]}%</td><td>${br.native[k]}%</td></tr>`)
        .join("") +
      `</tbody></table>`;
  }

  const src = document.getElementById("data-src");
  if (src) {
    src.innerHTML =
      `Source: Firefox Nightly, via ` +
      `<a href="${d.h3_discovery.explore_url}">GLAM</a>, updated ${when}. ` +
      `Per-connection estimate reconstructed from GLAM's histograms and averaged over recent builds, so approximate.`;
  }
}

document.addEventListener("DOMContentLoaded", loadGlam);
