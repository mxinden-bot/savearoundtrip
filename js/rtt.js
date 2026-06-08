/* Estimates the visitor's network round-trip time and surfaces it, to make a
 * "saved round trip" concrete. We warm an HTTPS connection to Cloudflare's
 * public DoH endpoint, then time several tiny requests over that already-open
 * connection and take the minimum as a conservative ~1 RTT estimate (the
 * server answers the repeated query from cache, so we mostly measure network
 * time, not DNS work). It is an estimate to a nearby edge, hence "~". */

async function measureRtt() {
  const url = "https://cloudflare-dns.com/dns-query?type=A&name=cloudflare.com";
  const opts = { headers: { accept: "application/dns-json" }, cache: "no-store" };
  try {
    await fetch(url, opts); // warm: DNS + TCP + TLS + protocol negotiation
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      const r = await fetch(url, opts);
      await r.arrayBuffer();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return Math.max(1, Math.round(samples[0]));
  } catch {
    return null;
  }
}

async function initRtt() {
  const slot = document.getElementById("rtt-clause");
  const ms = await measureRtt();
  if (ms == null) return; // leave empty; the distance ranges below still apply
  if (slot) slot.innerHTML = ` For you right now, one round trip is about <b>~${ms} ms</b>.`;
  renderRttViz(ms);
}

// A tiny bar: the measured round trip against the ~100 ms "feels instant" line.
function renderRttViz(ms) {
  const el = document.getElementById("rtt-viz");
  if (!el) return;
  const scaleMax = Math.max(120, Math.ceil((ms * 1.25) / 10) * 10);
  const fillPct = Math.min(100, (ms / scaleMax) * 100);
  const threshPct = (100 / scaleMax) * 100;
  el.innerHTML =
    `<div class="rttbar-track">` +
    `<div class="rttbar-fill" style="width:${fillPct.toFixed(1)}%"></div>` +
    `<div class="rttbar-thresh" style="left:${threshPct.toFixed(1)}%"></div>` +
    `</div>` +
    `<div class="rttbar-key">` +
    `<span><span class="rttbar-swatch"></span><b>~${ms} ms</b>: one round trip from you, what a published HTTPS record saves on the first connection</span>` +
    `<span>dashed line: 100 ms, where a delay stops feeling instant</span>` +
    `</div>` +
    `<p class="rttbar-how">Measured live in your browser: the fastest of several small requests to a nearby server, so an estimate, not a benchmark.</p>`;
  el.hidden = false;
}

document.addEventListener("DOMContentLoaded", initRtt);
