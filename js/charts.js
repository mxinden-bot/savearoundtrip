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

// Two bars per percentile, old protocol vs new, on one shared ms scale.
function renderPaired(el, rows, max) {
  el.innerHTML = "";
  for (const [label, a, b] of rows) {
    const w = (v) => Math.max(0.5, Math.min(100, (100 * v) / max)).toFixed(1);
    el.append(
      elem(
        "div",
        "pair",
        `<span class="bar-label">${label}</span><span class="pair-bars">` +
          `<span class="pair-row"><span class="bar-track"><span class="bar-fill c-old" style="width:${w(a)}%"></span></span><span class="bar-val">${a} ms</span></span>` +
          `<span class="pair-row"><span class="bar-track"><span class="bar-fill c-new" style="width:${w(b)}%"></span></span><span class="bar-val"><b>${b} ms</b></span></span>` +
          `</span>`
      )
    );
  }
}

// HTTP/3 share per Firefox version, as columns.
function renderColumns(el, labels, values) {
  const W = 720, H = 190, padT = 26, padB = 26, padX = 6;
  const max = Math.max(40, Math.ceil(Math.max(...values) / 10) * 10);
  const slot = (W - 2 * padX) / values.length, bw = Math.min(46, slot * 0.6);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  let s = "";
  values.forEach((v, i) => {
    const x = padX + slot * (i + 0.5);
    const last = i === values.length - 1;
    s +=
      `<rect class="col${last ? " last" : ""}" x="${(x - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - padB - y(v)).toFixed(1)}" rx="2"></rect>` +
      `<text class="cv${last ? " last" : ""}" x="${x.toFixed(1)}" y="${(y(v) - 7).toFixed(1)}" text-anchor="middle">${v}%</text>` +
      `<text class="ax" x="${x.toFixed(1)}" y="${H - 7}" text-anchor="middle">${labels[i]}</text>`;
  });
  el.innerHTML =
    `<svg class="col-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="HTTP/3 share of Firefox requests by Firefox version">` +
    `<line class="base" x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}"></line>${s}</svg>`;
}

function renderRelease(rel) {
  if (!rel) return;

  if (rel.rtt) {
    const t = document.getElementById("rtt-stats");
    if (t) {
      t.innerHTML = "";
      for (const [k, l] of [["p50", "median"], ["p75", "P75"], ["p95", "P95"], ["p99", "P99"]]) {
        const c = elem("div", "stat");
        c.append(elem("div", "n", `${rel.rtt[k]} ms`), elem("div", "l", l));
        t.append(c);
      }
    }
    set(
      "rtt-cap",
      `Round-trip time of HTTP/3 connections, Firefox ${rel.rtt.version} Release, all platforms. ` +
        `Source: GLAM: ${GLAM("networking_http_3_rtt", "networking.http_3_rtt")}.`
    );
  }

  if (rel.setup_tcp && rel.setup_quic) {
    const a = rel.setup_tcp, b = rel.setup_quic;
    const el = document.getElementById("chart-setup");
    if (el) renderPaired(el, [["P50", a.p50, b.p50], ["P75", a.p75, b.p75], ["P95", a.p95, b.p95]], Math.max(a.p95, b.p95));
    set(
      "setup-cap",
      `Connection setup time, desktop page loads to servers that speak HTTP/3, Firefox ${a.version} Release: ` +
        `TCP + TLS for HTTP/2 vs the QUIC handshake for HTTP/3. Source: GLAM: ` +
        `${GLAM("network_sup_http3_tcp_connection", "network.sup_http3_tcp_connection")}, ` +
        `${GLAM("network_http3_tls_handshake", "network.http3_tls_handshake")}.`
    );
  }

  const hv = rel.http_version;
  if (hv && hv.h3 && hv.h3.length) {
    const el = document.getElementById("chart-h3-share");
    if (el) renderColumns(el, hv.versions.map((v) => `v${v}`), hv.h3);
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
