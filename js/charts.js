/* Renders the Firefox numbers from data/glam.json (refreshed daily on CI from
 * GLAM; see scripts/fetch-glam.mjs), the Happy Eyeballs race and the
 * experiment results. Same-origin static files, so no CORS. */

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

// Round-trip time per connection as a cumulative curve on a log axis: the
// share of connections at or below each time, with median, P75 and P95 marked
// (as on the performance.now() 2026 slides).
function renderRttCdf(el, rtt) {
  const W = Math.max(300, el.clientWidth || 720);
  const narrow = W < 560;
  const padL = 42, padR = 14, padT = 22, padB = 28, H = narrow ? 240 : 280;
  const lo = 1, hi = 1000, L = Math.log10, base = H - padB;
  const x = (v) => padL + ((L(Math.min(Math.max(v, lo), hi)) - L(lo)) / (L(hi) - L(lo))) * (W - padL - padR);
  const y = (q) => padT + (1 - q / 100) * (base - padT);
  const pts = [[lo, 0], ...rtt.cdf.filter(([v]) => v <= hi)];

  let s = "";
  for (const q of [0, 25, 50, 75, 100]) {
    s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(q)}" y2="${y(q)}"></line>` +
      `<text class="ax" x="${padL - 6}" y="${y(q) + 4}" text-anchor="end">${q}%</text>`;
  }
  for (const t of [1, 10, 100, 1000]) {
    s += `<text class="ax" x="${Math.min(x(t), W - padR - 12)}" y="${H - 8}" text-anchor="middle">${msLabel(t)}</text>`;
  }
  s += `<text class="ax ytitle" x="${padL}" y="${padT - 9}">share of connections</text>`;
  s += `<path class="cdf-line" d="M${pts.map(([v, q]) => `${x(v).toFixed(1)},${y(q).toFixed(1)}`).join(" L")}"></path>`;

  const fs = narrow ? 12 : 13;
  for (const [name, v] of [["median", rtt.p50], ["P75", rtt.p75], ["P95", rtt.p95]]) {
    const q = (rtt.cdf.find((p) => p[0] === v) || [v, 0])[1];
    const px = x(v), py = y(q);
    s += `<line class="guide" x1="${padL}" x2="${px}" y1="${py}" y2="${py}"></line>` +
      `<line class="guide" x1="${px}" x2="${px}" y1="${py}" y2="${base}"></line>` +
      `<circle class="cdf-dot" cx="${px}" cy="${py}" r="5"></circle>` +
      `<text class="cdf-label" x="${px - 10}" y="${py + 4}" text-anchor="end" font-size="${fs}"><tspan class="pname">${name}</tspan> ${v} ms</text>`;
  }
  s += `<line class="cdf-cross" x1="0" x2="0" y1="${padT}" y2="${base}" visibility="hidden"></line>`;
  pts.slice(1).forEach(([v], i) => {
    const x0 = i === 0 ? padL : (x(pts[i][0]) + x(v)) / 2;
    const x1 = i + 2 < pts.length ? (x(v) + x(pts[i + 2][0])) / 2 : W - padR;
    s += `<rect class="hit" data-i="${i + 1}" x="${x0}" y="${padT}" width="${Math.max(1, x1 - x0)}" height="${base - padT}"></rect>`;
  });

  el.innerHTML =
    `<div class="trend cdf"><svg class="cdf-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
    `aria-label="Round-trip time of HTTP/3 connections: half at or below ${rtt.p50} ms, 75% at or below ${rtt.p75} ms, 95% at or below ${rtt.p95} ms">` +
    `<line class="base" x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}"></line>${s}</svg>` +
    `<div class="trend-tip" hidden></div></div>`;

  const wrap = el.firstChild, tip = wrap.querySelector(".trend-tip"), cross = wrap.querySelector(".cdf-cross");
  wrap.querySelectorAll("rect.hit").forEach((h) => {
    const [v, q] = pts[+h.dataset.i];
    const move = (e) => {
      cross.setAttribute("x1", x(v));
      cross.setAttribute("x2", x(v));
      cross.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.innerHTML = `<div class="tip-date">at or below ${msLabel(v)}</div><div class="tip-row">connections<span class="tip-v">${q}%</span></div>`;
      const box = wrap.getBoundingClientRect();
      let lx = e.clientX - box.left + 14;
      if (lx + 180 > box.width) lx = e.clientX - box.left - 180;
      tip.style.left = Math.max(4, lx) + "px";
      tip.style.top = Math.max(4, e.clientY - box.top + 12) + "px";
    };
    h.addEventListener("mouseenter", move);
    h.addEventListener("mousemove", move);
    h.addEventListener("mouseleave", () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
    });
  });
}

// Happy Eyeballs race, animated, as on the performance.now() 2026 slides.
// Simplified, but order and delays follow Firefox: DNS for the HTTPS record,
// AAAA and A at once; start once the HTTPS answer is in; QUIC/IPv6, QUIC/IPv4,
// TCP/IPv6, TCP/IPv4 at 0, 50, 150, 350 ms after the first attempt; the first
// to connect wins, the rest is cancelled.
const RACE = {
  usual: {
    end: 58, ms: 2600,
    dns: [["HTTPS record", 28], ["AAAA (IPv6)", 18], ["A (IPv4)", 14]],
    attempts: [["QUIC over IPv6", 28, 58, "win"], ["QUIC over IPv4", 78], ["TCP over IPv6", 178], ["TCP over IPv4", 378]],
    steps: [[0, "Ask DNS for the HTTPS record, AAAA and A at once."], [28, "Answers are in: start the best option, QUIC over IPv6."], [58, "QUIC connects. Nothing else to try."]],
  },
  blocked: {
    end: 223, ms: 6000,
    dns: [["HTTPS record", 28], ["AAAA (IPv6)", 18], ["A (IPv4)", 14]],
    attempts: [["QUIC over IPv6", 28, null, "lose"], ["QUIC over IPv4", 78, null, "lose"], ["TCP over IPv6", 178, 223, "win"], ["TCP over IPv4", 378]],
    steps: [[0, "Ask DNS for the HTTPS record, AAAA and A at once."], [28, "Start the best option: QUIC over IPv6."],
      [78, "No answer after 50 ms: also try QUIC over IPv4."], [178, "Still nothing: also try TCP over IPv6."],
      [223, "TCP connects first. The rest is cancelled, the user does not notice."]],
  },
};

function renderRace(el, sc, t) {
  const W = Math.max(300, el.clientWidth || 720);
  const narrow = W < 560;
  const labelW = narrow ? 118 : 180, padR = 10, fs = narrow ? 11.5 : 13, TMAX = 300;
  const x = (ms) => labelW + ((W - labelW - padR) * Math.min(ms, TMAX)) / TMAX;
  const done = t >= sc.end, charW = fs * 0.56;
  const dashed = (x0, x1, yy, h, closed) => {
    const st = `class="r-dash"`;
    return `<line ${st} x1="${x0}" y1="${yy}" x2="${x1}" y2="${yy}"/><line ${st} x1="${x0}" y1="${yy + h}" x2="${x1}" y2="${yy + h}"/>` +
      `<line ${st} x1="${x0}" y1="${yy}" x2="${x0}" y2="${yy + h}"/>` + (closed ? `<line ${st} x1="${x1}" y1="${yy}" x2="${x1}" y2="${yy + h}"/>` : "");
  };
  const rows = [...sc.dns.map((d) => ({ kind: "dns", label: "DNS: " + d[0], start: 0, stop: d[1] })),
    ...sc.attempts.map((a, i) => ({ kind: a[3] || "never", label: `${i + 1}: ${a[0]}`, start: a[1], stop: a[2] }))];
  const top = 22, LANE = 30;
  let s = "";
  rows.forEach((r, i) => {
    const yy = top + i * LANE + (r.kind === "dns" ? 0 : 10), h = r.kind === "dns" ? 16 : 22, mid = yy + h / 2 + 4;
    const started = t >= r.start, cancelled = done && r.kind === "lose";
    s += `<text class="lane${r.kind === "dns" ? "" : " strong"}${started || r.kind === "dns" ? "" : " off"}" x="0" y="${mid}" font-size="${fs}">${r.label}</text>`;
    if (r.kind === "dns" && t > 0) {
      s += `<rect class="${t >= r.stop ? "r-dnsdone" : "r-dns"}" x="${x(0)}" y="${yy}" width="${x(Math.min(t, r.stop)) - x(0)}" height="${h}" rx="3"/>`;
    } else if (r.kind === "win" && started) {
      if (t >= r.stop) {
        s += `<rect class="r-win" x="${x(r.start)}" y="${yy}" width="${x(r.stop) - x(r.start)}" height="${h}" rx="4"/>` +
          `<text class="r-note strong" x="${x(r.stop) + 8}" y="${mid}" font-size="${fs}">connected</text>`;
      } else s += dashed(x(r.start), x(t), yy, h, false);
    } else if (r.kind === "lose" && started) {
      const w = x(Math.min(t, sc.end)) - x(r.start), note = cancelled ? "no answer, cancelled" : "no answer";
      s += `<g opacity="${cancelled ? 0.5 : 1}">${dashed(x(r.start), x(r.start) + w, yy, h, cancelled)}` +
        (w > note.length * charW + 16 ? `<text class="r-note" x="${x(r.start) + 8}" y="${mid}" font-size="${fs}">${note}</text>` : "") + `</g>`;
    } else if (r.kind === "never" && done) {
      const inside = r.start < TMAX;
      s += `<text class="r-note off" x="${inside ? x(r.start) : W - padR}" y="${mid}" font-size="${fs}"${inside ? "" : ' text-anchor="end"'}>never started</text>`;
    }
  });
  const ay = top + rows.length * LANE + 20;
  s += `<line class="base" x1="${x(0)}" x2="${W - padR}" y1="${ay}" y2="${ay}"/>`;
  for (let ms = 0; ms <= TMAX; ms += 50) {
    if (narrow && ms % 100) continue;
    s += `<text class="ax" x="${x(ms)}" y="${ay + 16}" text-anchor="${ms ? "middle" : "start"}">${ms ? ms : "0 ms"}</text>`;
  }
  const cx = x(Math.min(t, sc.end));
  s += `<line class="r-cursor" x1="${cx}" x2="${cx}" y1="${top - 8}" y2="${ay}"/>`;
  if (!done) s += `<text class="r-time" x="${cx + 6}" y="${top - 10}" font-size="${fs}">${Math.round(t)} ms</text>`;
  const step = sc.steps.filter((p) => t >= p[0]).pop()[1];
  el.innerHTML =
    `<svg class="race-svg" viewBox="0 0 ${W} ${ay + 22}" width="${W}" height="${ay + 22}" role="img" aria-label="${step}">${s}</svg>` +
    `<p class="race-step">${step}</p>`;
}

// Loops like the slides: play, hold the final state for 3 s, play again, but
// only while the diagram is on screen. Click restarts it right away. Reduced
// motion shows the final state only.
function raceAnimate(el, sc) {
  const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hold = 300, rest = 3000;
  let t = still ? sc.end : 0, visible = false;
  const stop = () => {
    cancelAnimationFrame(el._raf);
    clearTimeout(el._timer);
  };
  const run = () => {
    stop();
    if (still) return renderRace(el, sc, sc.end);
    const t0 = performance.now();
    const frame = (now) => {
      const p = Math.max(0, (now - t0 - hold) / sc.ms);
      t = Math.min(1, p) * sc.end;
      renderRace(el, sc, t);
      if (p < 1) el._raf = requestAnimationFrame(frame);
      else el._timer = setTimeout(() => visible && run(), rest);
    };
    el._raf = requestAnimationFrame(frame);
  };
  sized.push(() => renderRace(el, sc, t));
  renderRace(el, sc, t);
  el.title = "click to replay";
  el.addEventListener("click", run);
  if (still) return;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => {
      const now = es.some((e) => e.isIntersecting);
      if (now && !visible) {
        visible = true;
        run();
      } else if (!now && visible) {
        visible = false;
        stop();
      }
    }, { threshold: 0.6 }).observe(el);
  } else {
    visible = true;
    run();
  }
}

// Two cumulative curves on a linear axis, 0 to 300 ms: connection setup over
// TCP + TLS (HTTP/2) vs QUIC (HTTP/3), medians marked; hover reads both.
function renderSetupCdf(el, sc) {
  const W = Math.max(300, el.clientWidth || 720);
  const narrow = W < 560;
  const padL = 42, padR = 14, padT = 22, padB = 28, H = narrow ? 240 : 280, TMAX = 300, base = H - padB;
  const x = (ms) => padL + (Math.min(ms, TMAX) / TMAX) * (W - padL - padR);
  const y = (q) => padT + (1 - q / 100) * (base - padT);
  const curve = (c) => {
    const pts = [[0, 0], ...c.cdf];
    const k = pts.findIndex(([ms]) => ms > TMAX);
    return k < 0 ? pts : pts.slice(0, k + 1);
  };
  const series = [["old", sc.tcp], ["new", sc.quic]];
  let s = "";
  for (const q of [0, 25, 50, 75, 100]) {
    s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(q)}" y2="${y(q)}"></line>` +
      `<text class="ax" x="${padL - 6}" y="${y(q) + 4}" text-anchor="end">${q}%</text>`;
  }
  for (let t = 0; t <= TMAX; t += narrow ? 100 : 50) {
    s += `<text class="ax" x="${Math.min(x(t), W - padR - 16)}" y="${H - 8}" text-anchor="middle">${t ? t + " ms" : "0"}</text>`;
  }
  s += `<text class="ax ytitle" x="${padL}" y="${padT - 9}">share of connections</text>`;
  s += `<clipPath id="setupclip"><rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}"/></clipPath>`;
  for (const [cls, c] of series) {
    s += `<path class="sc-line ${cls}" clip-path="url(#setupclip)" d="M${curve(c).map(([ms, q]) => `${x(ms).toFixed(1)},${y(q).toFixed(1)}`).join(" L")}"></path>`;
  }
  for (const [cls, c] of series) s += `<circle class="sc-dot ${cls}" cx="${x(c.p50)}" cy="${y(50)}" r="5"></circle>`;
  s += `<line class="cdf-cross" x1="0" x2="0" y1="${padT}" y2="${base}" visibility="hidden"></line>`;
  s += `<rect class="hit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${base - padT}"></rect>`;
  el.innerHTML =
    `<div class="trend cdf"><svg class="cdf-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
    `aria-label="Connection setup time: median ${Math.round(sc.tcp.p50)} ms over TCP and TLS, ${Math.round(sc.quic.p50)} ms over QUIC">` +
    `<line class="base" x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}"></line>${s}</svg>` +
    `<div class="trend-tip" hidden></div></div>`;
  const wrap = el.firstChild, tip = wrap.querySelector(".trend-tip"), cross = wrap.querySelector(".cdf-cross");
  const at = (c, ms) => { let q = 0; for (const [m, v] of c.cdf) { if (m > ms) break; q = v; } return q; };
  const hit = wrap.querySelector("rect.hit");
  const move = (e) => {
    const box = wrap.getBoundingClientRect(), svgBox = hit.ownerSVGElement.getBoundingClientRect();
    const px = e.clientX - svgBox.left;
    const ms = Math.max(0, Math.min(TMAX, ((px - padL) / (W - padL - padR)) * TMAX));
    cross.setAttribute("x1", x(ms));
    cross.setAttribute("x2", x(ms));
    cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<div class="tip-date">at or below ${Math.round(ms)} ms</div>` +
      `<div class="tip-row"><span class="tip-dot c-old"></span>TCP + TLS<span class="tip-v">${at(sc.tcp, ms)}%</span></div>` +
      `<div class="tip-row"><span class="tip-dot c-new"></span>QUIC<span class="tip-v">${at(sc.quic, ms)}%</span></div>`;
    let lx = e.clientX - box.left + 14;
    if (lx + 180 > box.width) lx = e.clientX - box.left - 180;
    tip.style.left = Math.max(4, lx) + "px";
    tip.style.top = Math.max(4, e.clientY - box.top + 12) + "px";
  };
  hit.addEventListener("mousemove", move);
  hit.addEventListener("mouseenter", move);
  hit.addEventListener("mouseleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
}

// FCP and LCP change by percentile, Happy Eyeballs v3 vs control (negative is
// faster), with a zero line; hover reads both at a percentile.
function renderChange(el, ex) {
  const W = Math.max(300, el.clientWidth || 720);
  const narrow = W < 560;
  const padL = 40, padR = narrow ? 40 : 48, padT = 22, padB = 28, H = narrow ? 230 : 260;
  const lo = Math.floor(Math.min(...ex.fcp.map((c) => c[1]), ...ex.lcp.map((c) => c[1])));
  const hi = Math.max(1, Math.ceil(Math.max(...ex.fcp.map((c) => c[1]), ...ex.lcp.map((c) => c[1]))));
  const x = (p) => padL + ((p - 10) / 89) * (W - padL - padR);
  const y = (v) => padT + ((hi - v) / (hi - lo)) * (H - padB - padT);
  let s = "";
  for (let v = lo; v <= hi; v++) {
    s += `<line class="${v === 0 ? "zero" : "grid"}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"></line>` +
      `<text class="ax" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v > 0 ? "+" : ""}${v}%</text>`;
  }
  for (const p of narrow ? [10, 50, 90, 99] : [10, 25, 50, 75, 90, 99]) {
    s += `<text class="ax" x="${x(p)}" y="${H - 8}" text-anchor="middle">P${p}</text>`;
  }
  s += `<text class="ax ytitle" x="${padL}" y="${padT - 9}">change vs control, lower is faster</text>`;
  for (const [cls, name, c] of [["fcp", "FCP", ex.fcp], ["lcp", "LCP", ex.lcp]]) {
    s += `<path class="ch-line ${cls}" d="M${c.map(([p, v]) => `${x(p).toFixed(1)},${y(v).toFixed(1)}`).join(" L")}"></path>`;
    const last = c[c.length - 1];
    s += `<text class="ch-end" x="${x(last[0]) + 6}" y="${y(last[1]) + 4}">${name}</text>`;
  }
  s += `<line class="cdf-cross" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"></line>`;
  s += `<rect class="hit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padB - padT}"></rect>`;
  el.innerHTML =
    `<div class="trend cdf"><svg class="cdf-svg ch-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
    `aria-label="Change in first and largest contentful paint with Happy Eyeballs v3, by percentile">${s}</svg>` +
    `<div class="trend-tip" hidden></div></div>`;
  const wrap = el.firstChild, tip = wrap.querySelector(".trend-tip"), cross = wrap.querySelector(".cdf-cross");
  const hit = wrap.querySelector("rect.hit");
  const fmt = (c) => `${c[1] > 0 ? "+" : ""}${c[1].toFixed(1)}% (${c[2] > 0 ? "+" : ""}${c[2]} ms)`;
  const move = (e) => {
    const box = wrap.getBoundingClientRect(), svgBox = hit.ownerSVGElement.getBoundingClientRect();
    const p = Math.max(10, Math.min(99, Math.round(10 + ((e.clientX - svgBox.left - padL) / (W - padL - padR)) * 89)));
    const f = ex.fcp.find((c) => c[0] === p), l = ex.lcp.find((c) => c[0] === p);
    cross.setAttribute("x1", x(p));
    cross.setAttribute("x2", x(p));
    cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<div class="tip-date">P${p}</div>` +
      `<div class="tip-row"><span class="tip-dot c-fcp"></span>FCP<span class="tip-v">${fmt(f)}</span></div>` +
      `<div class="tip-row"><span class="tip-dot c-lcp"></span>LCP<span class="tip-v">${fmt(l)}</span></div>`;
    let lx = e.clientX - box.left + 14;
    if (lx + 200 > box.width) lx = e.clientX - box.left - 200;
    tip.style.left = Math.max(4, lx) + "px";
    tip.style.top = Math.max(4, e.clientY - box.top + 12) + "px";
  };
  hit.addEventListener("mousemove", move);
  hit.addEventListener("mouseenter", move);
  hit.addEventListener("mouseleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
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
    if (el && rel.rtt.cdf) drawSized(() => renderRttCdf(el, rel.rtt));
    set("rtt-p50", `${rel.rtt.p50} ms`);
    set("rtt-p95", `${rel.rtt.p95} ms`);
    set(
      "rtt-cap",
      `Round-trip time of HTTP/3 connections, share of connections at or below each time, ` +
        `Firefox ${rel.rtt.version} Release, all platforms. Only servers that support HTTP/3, often ` +
        `large CDNs close to the user, so likely lower than for all servers. Source: GLAM: ` +
        `${GLAM("networking_http_3_rtt", "networking.http_3_rtt")}.`
    );
  }

  if (rel.setup_cdf) {
    const sc = rel.setup_cdf;
    const el = document.getElementById("chart-setup");
    if (el) drawSized(() => renderSetupCdf(el, sc));
    set("setup-med-tcp", `${Math.round(sc.tcp.p50)} ms`);
    set("setup-med-quic", `${Math.round(sc.quic.p50)} ms`);
    const fast = sc.quic.cdf.find(([ms]) => ms >= 1);
    set(
      "setup-cap",
      `Connection setup time, share of connections at or below each time, Firefox ${sc.version} Release, ` +
        `desktop page loads to servers that support HTTP/3: over HTTP/2 (TCP + TLS) vs over HTTP/3 (QUIC). ` +
        (fast ? `About ${Math.round(fast[1])}% of QUIC connections set up in about 1 ms or less, likely 0-RTT or resumed. ` : "") +
        `Source: GLAM: ${GLAM("network_sup_http3_tcp_connection", "network.sup_http3_tcp_connection")}, ` +
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
}

document.addEventListener("DOMContentLoaded", loadGlam);
document.addEventListener("DOMContentLoaded", () => {
  for (const [id, key] of [["race-usual", "usual"], ["race-blocked", "blocked"]]) {
    const el = document.getElementById(id);
    if (el) raceAnimate(el, RACE[key]);
  }
  const ch = document.getElementById("chart-change");
  if (ch && window.EXPERIMENT) drawSized(() => renderChange(ch, window.EXPERIMENT));
});
