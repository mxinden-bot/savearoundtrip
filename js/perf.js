/* The cost section's live demo. Two facts about THIS page, combined into one
 * picture: how long it took from opening the connection to first paint, and how
 * big a single round trip to this very server is. The document is same-origin,
 * so its Navigation Timing entry (including nextHopProtocol) is fully readable,
 * and a tiny same-origin request measures the real round trip to the server you
 * are actually talking to, not a separate endpoint. */

(function () {
  const SAMPLES = 6;
  const PING = "ping.txt"; // tiny same-origin resource, served from cache

  // One round trip to this origin: time several small requests over the
  // already-open connection and take the fastest (mostly network, not work).
  async function originRtt() {
    const opts = { cache: "no-store" };
    try {
      await fetch(PING, opts); // warm
      const samples = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now();
        const r = await fetch(PING, opts);
        await r.arrayBuffer();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return Math.max(1, Math.round(samples[0]));
    } catch {
      return null;
    }
  }

  function pageStats() {
    const navs = performance.getEntriesByType("navigation");
    if (!navs.length) return null;
    const n = navs[0];
    const fcp = performance
      .getEntriesByType("paint")
      .find((p) => p.name === "first-contentful-paint");
    const start = n.connectStart || n.fetchStart || 0;
    const end = fcp ? fcp.startTime : n.responseEnd;
    return {
      proto: n.nextHopProtocol || "",
      cached: n.transferSize === 0 && n.decodedBodySize > 0,
      connect: Math.max(0, n.connectEnd - n.connectStart),
      wait: Math.max(0, n.responseStart - n.requestStart),
      download: Math.max(0, n.responseEnd - n.responseStart),
      render: fcp ? Math.max(0, fcp.startTime - n.responseEnd) : 0,
      span: Math.max(0, end - start),
    };
  }

  const ms = (x) => Math.round(x);
  const protoName = (p) =>
    p === "h3"
      ? "HTTP/3"
      : p === "h2"
        ? "HTTP/2"
        : p && p.startsWith("http/1")
          ? "HTTP/1.1"
          : "";

  function render(s, rtt, el) {
    const total = s.span;
    if (!(total > 0)) {
      return;
    }

    // The "wait for first byte" segment is essentially one round trip to the
    // server, so highlight it; that is the slice a published HTTPS record saves.
    const segs = [
      ["Connection setup", s.connect, "pl-dns"],
      ["First byte (~1 round trip)", s.wait, "pl-rt"],
      ["Download", s.download, "pl-dl"],
      ["Render to first paint", s.render, "pl-render"],
    ].filter(([, v]) => v > 0.5);

    const bar = segs
      .map(
        ([label, v, cls]) =>
          `<span class="pl-seg ${cls}" style="width:${((v / total) * 100).toFixed(
            1,
          )}%" title="${label}: ${ms(v)} ms"></span>`,
      )
      .join("");

    const key = segs
      .map(
        ([label, v, cls]) =>
          `<span class="pl-keyitem"><span class="pl-sw ${cls}"></span>${label} ` +
          `<b>${ms(v)} ms</b></span>`,
      )
      .join("");

    const pn = protoName(s.proto);
    const proto = pn
      ? `over <span class="pl-badge${s.proto === "h3" ? " good" : ""}">${pn}</span> `
      : ``;
    const rttLine = rtt
      ? ` One round trip to this server, measured live, is <b>~${rtt} ms</b>, about ` +
        `the wait for the first byte. A published HTTPS record saves a browser one ` +
        `such round trip on its first connection.`
      : ` A published HTTPS record saves a browser one round trip on its first ` +
        `connection.`;

    el.innerHTML =
      `<p class="pl-headline">This page reached you ${proto}in <b>~${ms(total)} ms</b> ` +
      `from opening the connection to first paint.${rttLine}</p>` +
      `<div class="pl-bar">${bar}</div>` +
      `<div class="pl-key">${key}<span class="pl-keyitem pl-total">connection ` +
      `start to first paint <b>${ms(total)} ms</b></span></div>` +
      `<p class="pl-note">This page is static and tiny, so its whole budget is ` +
      `small. A real app's is bigger, but the round trip is the same fixed cost, ` +
      `paid up front and often to several origins.</p>`;
    el.hidden = false;
  }

  async function init() {
    const el = document.getElementById("pageload-viz");
    const s = pageStats();
    const rtt = await originRtt();

    const clause = document.getElementById("rtt-clause");
    if (rtt && clause) {
      clause.innerHTML = ` For you right now, one round trip to this server is about <b>~${rtt} ms</b>.`;
    }
    if (el && s && !s.cached) {
      render(s, rtt, el);
    }
  }

  // Run after load so responseEnd and first paint are populated.
  if (document.readyState === "complete") setTimeout(init, 0);
  else window.addEventListener("load", () => setTimeout(init, 0));
})();
