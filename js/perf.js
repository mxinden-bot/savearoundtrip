/* "One round trip isn't everything": seed a real latency budget from THIS
 * page's load. The document is same-origin, so its Navigation Timing entry
 * exposes the full breakdown, including nextHopProtocol and every connection
 * phase. We draw what the load actually cost and highlight the connection
 * setup, the part a published HTTPS record shrinks. */

(function () {
  function stats() {
    const navs = performance.getEntriesByType("navigation");
    if (!navs.length) return null;
    const n = navs[0];
    const fcp = performance
      .getEntriesByType("paint")
      .find((p) => p.name === "first-contentful-paint");

    const dns = Math.max(0, n.domainLookupEnd - n.domainLookupStart);
    const connect = Math.max(0, n.connectEnd - n.connectStart);
    const tls =
      n.secureConnectionStart > 0
        ? Math.max(0, n.connectEnd - n.secureConnectionStart)
        : 0;
    const wait = Math.max(0, n.responseStart - n.requestStart);
    const download = Math.max(0, n.responseEnd - n.responseStart);
    const end = fcp ? fcp.startTime : n.responseEnd;
    const render = fcp ? Math.max(0, fcp.startTime - n.responseEnd) : 0;

    return {
      proto: n.nextHopProtocol || "",
      reused: connect === 0,
      cached: n.transferSize === 0 && n.decodedBodySize > 0,
      dns,
      connect,
      tls,
      wait,
      download,
      render,
      end: Math.max(0, end),
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

  function render(s, el) {
    const total = s.end;
    if (!(total > 0)) return;

    // Whole document came from disk cache: there was no network this load.
    if (s.cached) {
      el.innerHTML =
        `<p class="pl-note">This page came from your browser cache on this visit, ` +
        `so it cost almost nothing to load. The bar above shows what a cold first ` +
        `connection costs.</p>`;
      el.hidden = false;
      return;
    }

    // The connection is often already warm by the time the document loads
    // (browsers pre-open it), so connect can read ~0. Show a connection segment
    // only when it is real; either way still show the rest of the budget.
    const showConn = s.connect > 0.5;
    const connClass = s.proto === "h3" ? "pl-conn good" : "pl-conn warn";
    const segs = [
      ["DNS lookup", s.dns, "pl-dns"],
      ["Connection setup", showConn ? s.connect : 0, connClass],
      ["Server wait", s.wait, "pl-wait"],
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
      ? `This page reached you over <span class="pl-badge${
          s.proto === "h3" ? " good" : ""
        }">${pn}</span>. `
      : ``;
    let setup;
    if (showConn && s.proto === "h3") {
      setup =
        `Opening that connection took <b>~${ms(s.connect)} ms</b>, about one QUIC ` +
        `round trip; discovered through <code>Alt-Svc</code> instead it would ` +
        `arrive only on a later connection.`;
    } else if (showConn) {
      setup =
        `Opening the connection took <b>~${ms(s.connect)} ms</b>` +
        (s.tls > 0.5 ? `, roughly two round trips (TCP, then TLS)` : ``) +
        `. Over HTTP/3 from a published HTTPS record, that could be about one ` +
        `round trip.`;
    } else {
      setup =
        `Your connection here was already warm (browsers often pre-open it), so it ` +
        `cost about nothing this time. The bar above shows what a cold round trip ` +
        `costs, the one a published HTTPS record saves on a first connection.`;
    }

    el.innerHTML =
      `<p class="pl-headline">${proto}${setup}</p>` +
      (segs.length
        ? `<div class="pl-bar">${bar}</div>` +
          `<div class="pl-key">${key}<span class="pl-keyitem pl-total">total to ` +
          `first paint <b>${ms(total)} ms</b></span></div>`
        : ``) +
      `<p class="pl-note">This page is static and tiny, so its whole budget is ` +
      `small. A real app's budget is bigger, but the connection setup is the same ` +
      `fixed cost, paid up front before any content and often to several origins.</p>`;
    el.hidden = false;
  }

  function init() {
    const el = document.getElementById("pageload-viz");
    if (!el || !performance.getEntriesByType) return;
    const s = stats();
    if (s) render(s, el);
  }

  // Run after load so responseEnd and first paint are populated.
  if (document.readyState === "complete") setTimeout(init, 0);
  else window.addEventListener("load", () => setTimeout(init, 0));
})();
