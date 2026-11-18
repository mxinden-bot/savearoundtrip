/* Renders the real-browser numbers from data/glam.json (refreshed daily on CI
 * from GLAM; see scripts/fetch-glam.mjs). Same-origin static file, so no CORS.
 *
 * Firefox Release: per-request shares and percentiles as GLAM reports them.
 * Firefox Nightly (HTTP/3 discovery, HTTPS record features): per-connection
 * estimates reconstructed from GLAM's non-normalized histograms. */

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

/* ---- Firefox Release numbers (round trips, setup time, adoption) ---- */

const GLAM = (probe, name) =>
  `<a href="https://glam.telemetry.mozilla.org/fog/probe/${probe}/explore">${name}</a>`;
const set = (id, html) => {
  const e = document.getElementById(id);
  if (e) e.innerHTML = html;
  return e;
};

const msLabel = (v) => (v >= 1000 ? `${v / 1000} s` : `${v} ms`);

// Charts drawn at the container's real pixel width (so text keeps its size on
// a phone) re-render on resize.
const sized = [];
let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => sized.forEach((f) => f()), 150);
});
function drawSized(f) {
  sized.push(f);
  f();
}

// Distribution of round-trip times on a log axis, one column per GLAM bucket
// (exponential buckets, so equal width), with the percentiles marked on it.
function renderRttHist(el, rtt) {
  const W = Math.max(300, el.clientWidth || 720);
  const narrow = W < 560;
  const padL = 30, padR = 12, padT = 44, padB = 24, H = narrow ? 200 : 230;
  const lo = 1, hi = 10000, L = Math.log10;
  const x = (v) => padL + ((L(Math.min(Math.max(v, lo), hi)) - L(lo)) / (L(hi) - L(lo))) * (W - padL - padR);
  const bs = rtt.hist.filter(([k]) => k >= lo && k < hi);
  const step = Math.max(...bs.map((b) => b[1])) > 6 ? 2 : 1;
  const yMax = Math.ceil(Math.max(...bs.map((b) => b[1])) / step) * step;
  const base = H - padB;
  const y = (s) => padT + (1 - s / yMax) * (base - padT);

  let grid = "";
  for (let t = 0; t <= yMax; t += step) {
    grid += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"></line>` +
      `<text class="ax" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}%</text>`;
  }
  for (const t of [1, 10, 100, 1000, 10000]) {
    grid += `<text class="ax" x="${x(t)}" y="${H - 6}" text-anchor="middle">${msLabel(t)}</text>`;
  }

  let cols = "", hits = "";
  bs.forEach(([k, share], i) => {
    const next = i + 1 < bs.length ? bs[i + 1][0] : hi;
    const x0 = x(k), x1 = x(next);
    const w = Math.max(1, x1 - x0 - 2), top = y(share), r = Math.min(2, w / 2);
    if (share > 0 && base - top > 0.5) {
      cols += `<path class="hcol" d="M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + w - r} Q${x0 + w},${top} ${x0 + w},${top + r} V${base} Z"></path>`;
    }
    hits += `<rect class="hit" data-i="${i}" x="${x0}" y="${padT}" width="${Math.max(1, x1 - x0)}" height="${base - padT}"></rect>`;
  });

  // Percentile markers: hairlines with labels in two staggered rows, so
  // neighbours (P50/P75, P95/P99) never collide.
  const fs = narrow ? 11 : 12;
  let marks = "";
  [["P50", rtt.p50], ["P75", rtt.p75], ["P95", rtt.p95], ["P99", rtt.p99]].forEach(([name, v], i) => {
    const xm = x(v), ly = i % 2 ? 32 : 15;
    const half = ((name.length + 1 + msLabel(v).length) * fs * 0.56) / 2;
    const lx = Math.min(Math.max(xm, padL + half), W - padR - half);
    marks += `<line class="pmark" x1="${xm}" x2="${xm}" y1="${padT - 6}" y2="${base}"></line>` +
      `<text class="plabel" x="${lx}" y="${ly}" text-anchor="middle" font-size="${fs}"><tspan class="pname">${name}</tspan> ${msLabel(v)}</text>`;
  });

  el.innerHTML =
    `<div class="trend hist"><svg class="hist-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
    `aria-label="Distribution of HTTP/3 round-trip times: median ${rtt.p50} ms, P75 ${rtt.p75} ms, P95 ${rtt.p95} ms, P99 ${rtt.p99} ms">` +
    `${grid}<line class="base" x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}"></line>${cols}${marks}${hits}</svg>` +
    `<div class="trend-tip" hidden></div></div>`;

  const wrap = el.firstChild, tip = wrap.querySelector(".trend-tip");
  wrap.querySelectorAll("rect.hit").forEach((h) => {
    const i = +h.dataset.i, [k, share] = bs[i], next = i + 1 < bs.length ? bs[i + 1][0] : hi;
    const move = (e) => {
      tip.hidden = false;
      tip.innerHTML = `<div class="tip-date">${k} to ${next} ms</div><div class="tip-row">share<span class="tip-v">${share}%</span></div>`;
      const box = wrap.getBoundingClientRect();
      let lx = e.clientX - box.left + 14;
      if (lx + 170 > box.width) lx = e.clientX - box.left - 170;
      tip.style.left = Math.max(4, lx) + "px";
      tip.style.top = Math.max(4, e.clientY - box.top + 12) + "px";
    };
    h.addEventListener("mouseenter", move);
    h.addEventListener("mousemove", move);
    h.addEventListener("mouseleave", () => (tip.hidden = true));
  });
}

// Before -> after per percentile: a gray dot (TCP + TLS) joined to a green dot
// (QUIC) on a linear axis from 0, so "about half" is visible; exact values in
// a column on the right.
function renderDumbbell(el, rows) {
  const W = Math.max(300, el.clientWidth || 720);
  const narrow = W < 560;
  const padL = 40, padR = narrow ? 92 : 120, rowH = 40, padT = 8, padB = 26;
  const H = padT + rows.length * rowH + padB;
  const max = Math.ceil(Math.max(...rows.map((r) => Math.max(r[1], r[2]))) / 200) * 200;
  const x = (v) => padL + (v / max) * (W - padL - padR);
  let s = "";
  for (let t = 0; t <= max; t += 200) {
    s += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${padT}" y2="${H - padB}"></line>` +
      `<text class="ax" x="${x(t)}" y="${H - 8}" text-anchor="middle">${t} ms</text>`;
  }
  rows.forEach(([name, a, b], i) => {
    const cy = padT + i * rowH + rowH / 2;
    s += `<text class="rowname" x="0" y="${cy + 4}">${name}</text>` +
      `<line class="dlink" x1="${x(b)}" x2="${x(a)}" y1="${cy}" y2="${cy}"></line>` +
      `<circle class="dot old" cx="${x(a)}" cy="${cy}" r="6"></circle>` +
      `<circle class="dot new" cx="${x(b)}" cy="${cy}" r="6"></circle>` +
      `<text class="dval" x="${W}" y="${cy + 4}" text-anchor="end">${a} <tspan class="arrow">&rarr;</tspan> <tspan class="strong">${b} ms</tspan></text>`;
  });
  el.innerHTML =
    `<svg class="dumb-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Connection setup time, TCP + TLS vs QUIC: ` +
    rows.map(([n, a, b]) => `${n} ${a} ms vs ${b} ms`).join(", ") + `">${s}</svg>`;
}

// HTTP/3 share by Firefox version: a trend, so a line with an area wash, the
// first and last values labelled, and a crosshair tooltip per version.
function renderShareLine(el, versions, values) {
  const W = Math.max(300, el.clientWidth || 720);
  const narrow = W < 560;
  const padL = 34, padR = 58, padT = 16, padB = 26, H = narrow ? 200 : 220;
  const max = Math.max(40, Math.ceil(Math.max(...values) / 10) * 10);
  const n = values.length;
  const x = (i) => padL + (n > 1 ? (i / (n - 1)) * (W - padL - padR) : 0);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const base = H - padB;

  let s = "";
  for (let t = 0; t <= max; t += 10) {
    s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"></line>` +
      `<text class="ax" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}%</text>`;
  }
  versions.forEach((v, i) => {
    if (!narrow || i % 2 === (n - 1) % 2) s += `<text class="ax" x="${x(i)}" y="${H - 7}" text-anchor="middle">${v}</text>`;
  });
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  s += `<path class="sl-area" d="M${x(0)},${base} L${pts.join(" L")} L${x(n - 1)},${base} Z"></path>`;
  s += `<path class="sl-line" d="M${pts.join(" L")}"></path>`;
  s += `<line class="sl-cross" x1="0" x2="0" y1="${padT}" y2="${base}" visibility="hidden"></line>`;
  s += `<circle class="sl-dot" cx="${x(n - 1)}" cy="${y(values[n - 1])}" r="5"></circle>`;
  s += `<circle class="sl-hover" r="5" cx="0" cy="0" visibility="hidden"></circle>`;
  s += `<text class="sl-end" x="${x(n - 1) + 10}" y="${y(values[n - 1]) + 5}">${values[n - 1]}%</text>`;
  s += `<text class="sl-start" x="${x(0)}" y="${y(values[0]) - 10}" text-anchor="start">${values[0]}%</text>`;
  const slot = n > 1 ? (W - padL - padR) / (n - 1) : W;
  values.forEach((_, i) => {
    s += `<rect class="hit" data-i="${i}" x="${x(i) - slot / 2}" y="${padT}" width="${slot}" height="${base - padT}"></rect>`;
  });

  el.innerHTML =
    `<div class="trend share"><svg class="share-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
    `aria-label="HTTP/3 share of Firefox requests by version: ${versions.map((v, i) => `${v} ${values[i]}%`).join(", ")}">${s}</svg>` +
    `<div class="trend-tip" hidden></div></div>`;

  const wrap = el.firstChild, tip = wrap.querySelector(".trend-tip");
  const cross = wrap.querySelector(".sl-cross"), dot = wrap.querySelector(".sl-hover");
  wrap.querySelectorAll("rect.hit").forEach((h) => {
    const i = +h.dataset.i;
    const move = (e) => {
      cross.setAttribute("x1", x(i));
      cross.setAttribute("x2", x(i));
      cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(i));
      dot.setAttribute("cy", y(values[i]));
      dot.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.innerHTML = `<div class="tip-date">Firefox ${versions[i].replace(/^v/, "")}</div><div class="tip-row">HTTP/3<span class="tip-v">${values[i]}%</span></div>`;
      const box = wrap.getBoundingClientRect();
      let lx = e.clientX - box.left + 14;
      if (lx + 170 > box.width) lx = e.clientX - box.left - 170;
      tip.style.left = Math.max(4, lx) + "px";
      tip.style.top = Math.max(4, e.clientY - box.top + 12) + "px";
    };
    h.addEventListener("mouseenter", move);
    h.addEventListener("mousemove", move);
    h.addEventListener("mouseleave", () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
    });
  });
}

function renderRelease(rel) {
  if (!rel) return;

  if (rel.rtt) {
    const el = document.getElementById("chart-rtt");
    if (el && rel.rtt.hist) drawSized(() => renderRttHist(el, rel.rtt));
    set(
      "rtt-cap",
      `Round-trip time of HTTP/3 connections, Firefox ${rel.rtt.version} Release, all platforms, ` +
        `each client weighted equally (as GLAM reports it). Source: GLAM: ` +
        `${GLAM("networking_http_3_rtt", "networking.http_3_rtt")}.`
    );
  }

  if (rel.setup_tcp && rel.setup_quic) {
    const a = rel.setup_tcp, b = rel.setup_quic;
    const el = document.getElementById("chart-setup");
    if (el) drawSized(() => renderDumbbell(el, [["P50", a.p50, b.p50], ["P75", a.p75, b.p75], ["P95", a.p95, b.p95]]));
    set(
      "setup-cap",
      `Connection setup time, desktop page loads to servers that speak HTTP/3, Firefox ${a.version} Release, ` +
        `each client weighted equally: TCP + TLS for HTTP/2 vs the QUIC handshake for HTTP/3. Source: GLAM: ` +
        `${GLAM("network_sup_http3_tcp_connection", "network.sup_http3_tcp_connection")}, ` +
        `${GLAM("network_http3_tls_handshake", "network.http3_tls_handshake")}.`
    );
  }

  const hv = rel.http_version;
  if (hv && hv.h3 && hv.h3.length) {
    const el = document.getElementById("chart-h3-share");
    if (el) drawSized(() => renderShareLine(el, hv.versions.map((v) => `v${v}`), hv.h3));
    set(
      "h3-share-cap",
      `Share of HTTP responses that came over HTTP/3, Firefox Release, by version. ` +
        `Source: GLAM: ${GLAM("networking_http_response_version", "networking.http_response_version")}.`
    );
  }

  if (rel.ipv6 && rel.tls13 && hv) {
    const h3now = hv.h3[hv.h3.length - 1];
    const el = document.getElementById("chart-adopt");
    if (el)
      renderBars(el, [
        ["IPv6, 1998", rel.ipv6.share, "c-old"],
        ["TLS 1.3, 2018", rel.tls13.share, "c-new"],
        ["HTTP/3, 2022", h3now, "c-new"],
      ]);
    set(
      "adopt-cap",
      `Share of Firefox ${rel.tls13.version} Release traffic: IPv6 of HTTP requests ` +
        `(${GLAM("networking_connection_address_type", "networking.connection_address_type")}), ` +
        `TLS 1.3 of TLS handshakes (${GLAM("tls_handshake_version", "tls_handshake_version")}), ` +
        `HTTP/3 of HTTP responses (${GLAM("networking_http_response_version", "networking.http_response_version")}). ` +
        `Year of the standard: <a href="https://www.rfc-editor.org/rfc/rfc2460">RFC 2460</a>, ` +
        `<a href="https://www.rfc-editor.org/rfc/rfc8446">RFC 8446</a>, ` +
        `<a href="https://www.rfc-editor.org/rfc/rfc9114">RFC 9114</a>.`
    );
  }
}

async function loadGlam() {
  let d;
  try {
    const r = await fetch("data/glam.json", { cache: "no-store" });
    if (!r.ok) throw new Error("no glam.json");
    d = await r.json();
  } catch {
    const section = document.getElementById("data");
    if (section) section.hidden = true;
    return;
  }

  renderRelease(d.release);

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

  // The discovery probe's data stops at some build; say which, rather than
  // implying it is as fresh as the rest of the page.
  const pts = (d.h3_discovery.series || []).filter((p) => STACK.some((k) => p[k] > 0));
  const lastBuild = pts.length ? pts[pts.length - 1].date : "";
  set(
    "data-src",
    `Each bar is one Nightly build${lastBuild ? `, up to ${lastBuild}` : ""}. Source: Firefox Nightly, via ` +
      `<a href="${d.h3_discovery.explore_url}">GLAM</a>. Per-connection estimate reconstructed from ` +
      `GLAM's histograms and averaged over recent builds, so approximate.`
  );
}

document.addEventListener("DOMContentLoaded", loadGlam);
