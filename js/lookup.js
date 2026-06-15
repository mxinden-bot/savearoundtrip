/* savearoundtrip: live HTTPS-RR lookup via Cloudflare DNS-over-HTTPS.
 *
 * Cloudflare's DoH JSON endpoint returns type-65 (HTTPS) records as RFC 3597
 * "generic" RDATA, e.g.  "\# 61 00 01 00 00 01 00 06 02 68 33 ..."
 * so we decode the SVCB/HTTPS wire format (RFC 9460 §2.2) ourselves.
 */

const DOH = "https://cloudflare-dns.com/dns-query";
const TYPE_HTTPS = 65;

// Backend that checks Alt-Svc (advertised h3) and a real HTTP/3 handshake,
// since a browser can do neither. See check-service/. If unreachable, the
// page still works (DNS-only).
const CHECK_API = "https://savearoundtrip-check.fly.dev/check";

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// SvcParamKeys: RFC 9460 §14.3.2 (+ the `ech` key).
const SVC_KEYS = {
  0: "mandatory",
  1: "alpn",
  2: "no-default-alpn",
  3: "port",
  4: "ipv4hint",
  5: "ech",
  6: "ipv6hint",
};

/* ---- wire-format helpers ---- */

// "\# 61 00 01 ..." -> Uint8Array. Returns null if it isn't generic form.
function parseGeneric(data) {
  const s = data.trim();
  if (!s.startsWith("\\#")) return null;
  const parts = s.split(/\s+/).slice(1);          // drop "\#"
  const len = parseInt(parts.shift(), 10);
  const bytes = parts.map((h) => parseInt(h, 16));
  if (bytes.length !== len || bytes.some(isNaN)) return null;
  return Uint8Array.from(bytes);
}

function readName(buf, pos) {
  // Uncompressed domain name. "." (root) is a single 0 byte.
  const labels = [];
  while (buf[pos] !== 0) {
    const n = buf[pos++];
    labels.push(String.fromCharCode(...buf.slice(pos, pos + n)));
    pos += n;
  }
  return [labels.length ? labels.join(".") + "." : ".", pos + 1];
}

function ipv4(b) { return Array.from(b).join("."); }

function ipv6(b) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  }
  // collapse the longest run of zero groups into "::"
  let best = -1, bestLen = 0, run = -1, runLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === "0") {
      if (run < 0) run = i;
      if (++runLen > bestLen) { bestLen = runLen; best = run; }
    } else { run = -1; runLen = 0; }
  }
  if (bestLen > 1) {
    const head = groups.slice(0, best).join(":");
    const tail = groups.slice(best + bestLen).join(":");
    return `${head}::${tail}`;
  }
  return groups.join(":");
}

// Decode HTTPS/SVCB RDATA -> { priority, target, params: {alpn, ipv4hint, ...} }
function parseSvcb(buf) {
  let pos = 0;
  const priority = (buf[pos] << 8) | buf[pos + 1];
  pos += 2;
  let target;
  [target, pos] = readName(buf, pos);

  const params = {};
  while (pos < buf.length) {
    const key = (buf[pos] << 8) | buf[pos + 1];
    const vlen = (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    const v = buf.slice(pos, pos + vlen);
    pos += vlen;
    const name = SVC_KEYS[key] || `key${key}`;

    switch (name) {
      case "alpn": {
        const ids = [];
        let p = 0;
        while (p < v.length) {
          const n = v[p++];
          ids.push(String.fromCharCode(...v.slice(p, p + n)));
          p += n;
        }
        params.alpn = ids;
        break;
      }
      case "no-default-alpn":
        params["no-default-alpn"] = true;
        break;
      case "port":
        params.port = (v[0] << 8) | v[1];
        break;
      case "ipv4hint": {
        const out = [];
        for (let i = 0; i < v.length; i += 4) out.push(ipv4(v.slice(i, i + 4)));
        params.ipv4hint = out;
        break;
      }
      case "ipv6hint": {
        const out = [];
        for (let i = 0; i < v.length; i += 16) out.push(ipv6(v.slice(i, i + 16)));
        params.ipv6hint = out;
        break;
      }
      case "ech":
        params.ech = vlen; // present; value is an opaque ECHConfigList
        break;
      case "mandatory":
        params.mandatory = true;
        break;
      default:
        params[name] = vlen;
    }
  }
  return { priority, target, params };
}

/* ---- the lookup ---- */

async function lookup(domain) {
  const url = `${DOH}?name=${encodeURIComponent(domain)}&type=HTTPS`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const json = await res.json();
  const answers = (json.Answer || []).filter((a) => a.type === TYPE_HTTPS);
  const records = [];
  for (const a of answers) {
    const bytes = parseGeneric(a.data);
    if (bytes) records.push({ ...parseSvcb(bytes), ttl: a.TTL });
  }
  return { status: json.Status, records, raw: answers };
}

/* ---- rendering ---- */

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function pills(arr, hot) {
  return arr
    .map((x) => `<span class="pill${hot && hot(x) ? " h3" : ""}">${x}</span>`)
    .join("");
}

// A ready-to-paste BIND-style record for a domain that's missing h3.
function zoneSnippet(domain) {
  return `${domain}.  3600  IN  HTTPS  1 . alpn="h3,h2"`;
}

function publishHint(domain) {
  const wrap = el("div", "publish-hint");
  wrap.append(el("div", "ph-label", "Publish this (tune the TTL, add IP hints / ECH as needed):"));
  const pre = el("pre", "ph-pre");
  pre.append(
    el(
      "code",
      null,
      `<span class="tok-com">; BIND-style zone file</span>\n` +
        `${domain}.  3600  IN  <span class="tok-key">HTTPS</span> ` +
        `<span class="tok-val">1 . alpn="h3,h2"</span>`
    )
  );
  wrap.append(pre);
  const btn = el("button", "copy-btn", "copy");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(zoneSnippet(domain));
      btn.textContent = "copied ✓";
    } catch {
      btn.textContent = "copy failed";
    }
    setTimeout(() => (btn.textContent = "copy"), 1500);
  });
  wrap.append(btn);
  return wrap;
}

function summarizeDns(out) {
  const hasRecord = out.records.length > 0;
  const aliasOnly = hasRecord && out.records.every((r) => r.priority === 0);
  const hasH3 = out.records.some((r) => (r.params.alpn || []).includes("h3"));
  return { hasRecord, aliasOnly, hasH3 };
}

// The HTTPS record's parameters, one <ul> per record.
function recordFacts(out) {
  const frag = document.createDocumentFragment();
  out.records.forEach((r, i) => {
    const p = r.params;
    const facts = el("ul", "facts");
    const row = (k, v) =>
      facts.append(el("li", null, `<span class="k">${k}</span><span class="val">${v}</span>`));

    if (out.records.length > 1) row("record", `#${i + 1}`);
    row("mode", r.priority === 0 ? "0 (AliasMode)" : `${r.priority} (ServiceMode)`);
    row("target", `<code>${escapeHtml(r.target)}</code>${r.target === "." ? " <span class=\"dim\">(same as owner)</span>" : ""}`);
    if (p.alpn) row("alpn", pills(p.alpn, (x) => x === "h3"));
    if (p["no-default-alpn"]) row("no-default-alpn", "set");
    if (p.port != null) row("port", String(p.port));
    if (p.ipv4hint) row("ipv4hint", pills(p.ipv4hint));
    if (p.ipv6hint) row("ipv6hint", pills(p.ipv6hint));
    row("ech", p.ech ? `configured (${p.ech} bytes) ✓` : `<span class="dim">not set</span>`);
    if (r.ttl != null) row("ttl", `${r.ttl}s`);
    frag.append(facts);
  });
  return frag;
}

// Evidence card 1: what DNS says.
function dnsCard(domain, out, dns) {
  const card = el("div", "evidence");
  card.append(el("div", "ev-head", `In DNS <span class="ev-dim">— the HTTPS record</span>`));
  if (!dns.hasRecord) {
    card.append(el("div", "ev-empty", `No HTTPS record for <code>${escapeHtml(domain)}</code>.`));
  } else {
    card.append(recordFacts(out));
  }
  return card;
}

// Evidence card 2: what the server actually does (filled in async).
function wireCard() {
  const card = el("div", "evidence");
  card.append(el("div", "ev-head", `Over the wire <span class="ev-dim">— what the server does</span>`));
  card._body = el("div", "ev-body", `<span class="spin">checking Alt-Svc and a live HTTP/3 handshake…</span>`);
  card.append(card._body);
  return card;
}

function fillWire(card, live) {
  const body = card._body;
  body.innerHTML = "";
  if (live.state === "unavailable") {
    body.append(el("div", "ev-empty", "Couldn't reach the checker (it may be waking up). The DNS result still stands; try again in a moment."));
    return;
  }
  if (live.state === "skipped") {
    body.append(el("div", "ev-empty", escapeHtml(live.error || "check skipped") + "."));
    return;
  }
  const facts = el("ul", "facts");
  const yn = (b) => (b ? `<span class="pill h3">yes</span>` : `<span class="pill">no</span>`);
  const row = (k, v) => facts.append(el("li", null, `<span class="k">${k}</span><span class="val">${v}</span>`));
  row("Alt-Svc lists h3", yn(live.advertises_h3));
  row("HTTP/3 handshake", yn(live.h3_handshake_ok));
  if (live.alt_svc) row("Alt-Svc", `<code>${escapeHtml(live.alt_svc)}</code>`);
  body.append(facts);
}

// The single combined verdict, derived from DNS plus the live check.
function computeVerdict(domain, dns, live) {
  const done = live.state === "done";
  const checking = live.state === "pending";
  const speaks = done && (live.h3_handshake_ok || live.advertises_h3);
  const tail = checking ? ` <span class="dim">(checking the server live…)</span>` : ``;

  if (dns.aliasOnly) {
    return ["warn", "HTTPS record is an alias (AliasMode)",
      `It points elsewhere; the h3 / ECH / hint parameters live on the HTTPS record at that target, not here.${tail}`];
  }
  if (!dns.hasRecord) {
    if (done && speaks) {
      return ["warn", "Speaks HTTP/3, but nothing in DNS",
        `This is the gap: the server does HTTP/3, but with no HTTPS record the first connection can't use it. Publish one:`,
        publishHint(domain)];
    }
    if (checking) {
      return ["warn", "No HTTPS record", `Checking whether the server speaks HTTP/3 anyway…`];
    }
    return ["warn", "No HTTPS record",
      `Publish one with <code>alpn="h3"</code> so browsers reach HTTP/3 on the first connection:`,
      publishHint(domain)];
  }
  if (dns.hasH3) {
    if (done && live.h3_handshake_ok) {
      return ["ok", "Optimal: HTTP/3 on the first connection ✓",
        `Advertised in DNS, and the server completes a live HTTP/3 handshake.`];
    }
    if (done) {
      return ["ok", "Advertises h3 in DNS ✓",
        `Browsers can try HTTP/3 on the first connection. Our checker didn't complete a live handshake just now (it may be rate-limited, or the server was briefly unreachable).`];
    }
    return ["ok", "Advertises h3 in DNS ✓",
      `Browsers can negotiate HTTP/3 on the first connection.${tail}`];
  }
  // ServiceMode record without h3
  if (done && speaks) {
    return ["warn", "Server speaks HTTP/3, but DNS doesn't list it",
      `Add <code>h3</code> to the record's <code>alpn</code> so the first connection can use it:`,
      publishHint(domain)];
  }
  return ["warn", "HTTPS record has no h3",
    `The record exists but doesn't list <code>h3</code>. Add it to the <code>alpn</code> set:`,
    publishHint(domain)];
}

function renderVerdict(slot, domain, dns, live) {
  const [kind, title, sub, extra] = computeVerdict(domain, dns, live);
  slot.innerHTML = "";
  slot.append(verdict(kind, title, sub, extra));
}

function verdict(kind, title, sub, extra) {
  const c = el("div", `verdict-card ${kind}`);
  c.append(el("div", "v-title", title));
  c.append(el("div", "v-sub", sub));
  if (extra) c.append(extra);
  return c;
}

// The checker scales to zero (Fly), so the first call can be a cold start.
// Allow generous time and one retry before giving up.
async function fetchCheck(domain) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(`${CHECK_API}?domain=${encodeURIComponent(domain)}`, { cache: "no-store", signal: ctrl.signal });
        return await r.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (attempt === 1) throw e;
      await new Promise((res) => setTimeout(res, 1200));
    }
  }
}

// Ask the backend for Alt-Svc + a live HTTP/3 handshake, then fill the wire
// card and fold the result into the single combined verdict.
async function connectionChecks(domain, dns, vSlot, wCard) {
  let live;
  try {
    const d = await fetchCheck(domain);
    live = d.error ? { state: "skipped", error: d.error } : { state: "done", ...d };
  } catch {
    live = { state: "unavailable" };
  }
  fillWire(wCard, live);
  renderVerdict(vSlot, domain, dns, live);
}

// Wake the checker as soon as the user engages, to dodge cold-start delays.
let warmed = false;
function warmChecker() {
  if (warmed) return;
  warmed = true;
  fetch(`${CHECK_API}?domain=savearoundtrip.com`, { cache: "no-store" }).catch(() => {});
}

/* ---- wire-up ---- */

function init() {
  const form = document.getElementById("lookup-form");
  const input = document.getElementById("domain");
  const btn = document.getElementById("go");
  const result = document.getElementById("result");
  if (!form) return;

  if (input) input.addEventListener("focus", warmChecker, { once: true });

  async function run(domain) {
    domain = (domain || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.$/, "");
    if (!domain) return;
    input.value = domain;

    if (!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
      result.innerHTML = "";
      result.append(
        verdict("err", "That doesn't look like a domain", "Try something like <code>example.com</code>.")
      );
      return;
    }

    btn.disabled = true;
    result.setAttribute("aria-busy", "true");
    result.innerHTML = `<div class="spin">querying cloudflare-dns.com for ${domain} HTTPS …</div>`;
    try {
      const out = await lookup(domain);
      const dns = summarizeDns(out);
      result.innerHTML = "";
      const vSlot = el("div", "verdict-slot");
      const wCard = wireCard();
      result.append(vSlot, dnsCard(domain, out, dns), wCard);
      renderVerdict(vSlot, domain, dns, { state: "pending" });
      connectionChecks(domain, dns, vSlot, wCard);
    } catch (e) {
      result.innerHTML = "";
      result.append(
        verdict("err", "Lookup failed", `Couldn't reach the DoH endpoint: ${e.message}`)
      );
    } finally {
      btn.disabled = false;
      result.setAttribute("aria-busy", "false");
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(input.value);
  });

  document.querySelectorAll("[data-example]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      run(a.dataset.example);
    })
  );

  // deep-link: #lookup=example.com
  const m = location.hash.match(/lookup=([^&]+)/);
  if (m) run(decodeURIComponent(m[1]));
}

document.addEventListener("DOMContentLoaded", init);
