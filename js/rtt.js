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
  if (!slot) return;
  const ms = await measureRtt();
  if (ms == null) return; // leave empty; the distance ranges below still apply
  slot.innerHTML = ` For you right now, one round trip is about <b>~${ms} ms</b>.`;
}

document.addEventListener("DOMContentLoaded", initRtt);
