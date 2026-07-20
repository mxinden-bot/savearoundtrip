/* savearoundtrip: live HTTPS-RR lookup via Cloudflare DNS-over-HTTPS.
 *
 * Cloudflare's DoH JSON endpoint returns type-65 (HTTPS) records as RFC 3597
 * "generic" RDATA, e.g.  "\# 61 00 01 00 00 01 00 06 02 68 33 ..."
 * so we decode the SVCB/HTTPS wire format (RFC 9460 §2.2) ourselves.
 */

const DOH = "https://cloudflare-dns.com/dns-query";
const TYPE_HTTPS = 65;

// RFC 9460 requires a cap on the number of AliasMode records followed per
// resolution (2.4.2: "MUST impose a limit ... MUST NOT be zero"). Firefox uses
// 8 (bug 1869075 / D312868); we mirror that.
const MAX_ALIAS_HOPS = 8;

// Domain names are case-insensitive; normalize for display and loop detection.
const normName = (n) => String(n).toLowerCase().replace(/\.$/, "");

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

// Follow AliasMode (priority-0) HTTPS records to their TargetName, per RFC 9460
// 2.5.1, the way a browser does (Firefox bug 1869075). Chases up to
// MAX_ALIAS_HOPS aliases and stops at the first ServiceMode record, an empty
// answer, a "." target (service not available, 2.5.1), or a loop.
//
// Returns { hops:[{name,target}], finalName, out, status } where status is one
// of: "resolved" (out holds the terminal ServiceMode/empty answer),
// "unavailable" ("." target), "loop", or "toodeep".
async function resolveChain(domain) {
  const hops = [];
  const seen = new Set([normName(domain)]);
  let name = domain;
  let out = await lookup(name);

  for (let i = 0; i < MAX_ALIAS_HOPS; i++) {
    // 2.4.1: an AliasMode record in the set makes ServiceMode records moot.
    const alias = out.records.find((r) => r.priority === 0);
    if (!alias) return { hops, finalName: name, out, status: "resolved" };

    hops.push({ name, target: alias.target });
    if (alias.target === ".") return { hops, finalName: name, out, status: "unavailable" };

    const target = normName(alias.target);
    // 2.4.2: TargetName SHOULD NOT equal the owner name; a repeat is a loop.
    if (!target || seen.has(target)) return { hops, finalName: name, out, status: "loop" };

    seen.add(target);
    name = target;
    out = await lookup(name);
  }
  return { hops, finalName: name, out, status: "toodeep" };
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

// The chain of names we walked, shown as "example.com -> svc.example.net".
function aliasTrace(domain, hops) {
  const names = [normName(domain)];
  for (const h of hops) names.push(h.target === "." ? "(unavailable)" : normName(h.target));
  const wrap = el("div", "alias-trace");
  wrap.innerHTML =
    `<span class="at-label">Alias chain</span>` +
    names.map((n) => `<code>${escapeHtml(n)}</code>`).join(`<span class="at-arrow">&rarr;</span>`);
  return wrap;
}

// Render the fact cards for one name's records, labelling which name they came
// from when we followed an alias to get here.
function renderRecordCards(records, ownerName, whereLabel, target) {
  records.forEach((r, i) => {
    const p = r.params;
    const facts = el("ul", "facts");
    const row = (k, v) =>
      facts.append(el("li", null, `<span class="k">${k}</span><span class="val">${v}</span>`));

    if (whereLabel) row("at", `<code>${escapeHtml(ownerName)}</code>`);
    if (records.length > 1) row("record", `#${i + 1}`);
    row("mode", r.priority === 0 ? "0 (AliasMode)" : `${r.priority} (ServiceMode)`);
    row("target", `<code>${r.target}</code>${r.target === "." ? " <span class=\"dim\">(same as owner)</span>" : ""}`);
    if (p.alpn) row("alpn", pills(p.alpn, (x) => x === "h3"));
    if (p["no-default-alpn"]) row("no-default-alpn", "set");
    if (p.port != null) row("port", String(p.port));
    if (p.ipv4hint) row("ipv4hint", pills(p.ipv4hint));
    if (p.ipv6hint) row("ipv6hint", pills(p.ipv6hint));
    row("ech", p.ech ? `<span class="val">configured (${p.ech} bytes) ✓</span>` : "<span class=\"dim\">not set</span>");
    if (r.ttl != null) row("ttl", `${r.ttl}s`);

    const card = el("div", "verdict-card");
    card.append(facts);
    target.append(card);
  });
}

function render(domain, chain, target) {
  target.innerHTML = "";
  const { hops, finalName, out, status } = chain;
  const followed = hops.length > 0;
  if (followed) target.append(aliasTrace(domain, hops));

  if (status === "loop") {
    target.append(
      verdict(
        "err",
        "HTTPS alias loops",
        `The AliasMode chain from <code>${escapeHtml(domain)}</code> points back to a ` +
          `name it already visited, so it never resolves to a service. RFC 9460 says the ` +
          `alias target must not loop; a browser stops here.`
      )
    );
    return;
  }

  if (status === "toodeep") {
    target.append(
      verdict(
        "err",
        "HTTPS alias chain too long",
        `Followed ${MAX_ALIAS_HOPS} AliasMode records without reaching a service. ` +
          `Browsers cap the chain (Firefox at ${MAX_ALIAS_HOPS}) and give up, so this ` +
          `record is effectively unusable.`
      )
    );
    return;
  }

  if (status === "unavailable") {
    target.append(
      verdict(
        "warn",
        "Alias says the service is not available",
        `<code>${escapeHtml(finalName)}</code> has an AliasMode record with target ` +
          `<code>.</code> (root), which RFC 9460 uses to signal that the service does ` +
          `not exist here. Clients may ignore it and connect normally.`
      )
    );
    return;
  }

  // status === "resolved": `out` holds the terminal name's records.
  const hasH3 = out.records.some((r) => (r.params.alpn || []).includes("h3"));

  if (!out.records.length) {
    if (followed) {
      target.append(
        verdict(
          "warn",
          "Alias target has no HTTPS record",
          `<code>${escapeHtml(domain)}</code> aliases to <code>${escapeHtml(finalName)}</code>, ` +
            `but that name publishes no HTTPS record, so there's no h3 to discover from DNS. ` +
            `Browsers fall back to its A/AAAA addresses. Publish an HTTPS record at the target:`,
          publishHint(finalName)
        )
      );
    } else {
      target.append(
        verdict(
          "warn",
          "No HTTPS record published",
          `<code>${escapeHtml(domain)}</code> has no HTTPS RR. If it serves HTTP/3, browsers ` +
            `can only discover that <i>after</i> a first connection (e.g. via an ` +
            `<code>Alt-Svc</code> HTTP header), costing a wasted round trip. ` +
            `Publishing an HTTPS RR with <code>alpn="h3"</code> fixes that.`,
          publishHint(domain)
        )
      );
    }
    return;
  }

  const where = followed ? ` (via alias to <code>${escapeHtml(finalName)}</code>)` : "";
  if (hasH3) {
    target.append(
      verdict(
        "ok",
        "HTTPS record found: advertises h3 &#10003;",
        `Browsers can negotiate HTTP/3 on the <b>first</b> connection${where}. ` +
          `No round trip wasted.`
      )
    );
  } else {
    target.append(
      verdict(
        "warn",
        "HTTPS record found, but no h3 in ALPN",
        `The record${where} doesn't list <code>h3</code>, so clients won't ` +
          `try HTTP/3 from DNS. Add <code>h3</code> to the <code>alpn</code> set.`,
        publishHint(finalName)
      )
    );
  }

  renderRecordCards(out.records, finalName, followed, target);
}

function verdict(kind, title, sub, extra) {
  const c = el("div", `verdict-card ${kind}`);
  c.append(el("div", "v-title", title));
  c.append(el("div", "v-sub", sub));
  if (extra) c.append(extra);
  return c;
}

// Asks the backend for Alt-Svc (advertised h3) and a live HTTP/3 handshake,
// then appends a verdict relating that to the DNS record result.
async function connectionChecks(domain, target, rrHasH3) {
  const pending = el("div", "verdict-card");
  pending.append(el("div", "v-sub", `<span class="spin">checking Alt-Svc and a live HTTP/3 handshake</span>`));
  target.append(pending);

  let d;
  try {
    const r = await fetch(`${CHECK_API}?domain=${encodeURIComponent(domain)}`, { cache: "no-store" });
    d = await r.json();
  } catch {
    pending.replaceWith(verdict("", "Live HTTP/3 check unavailable", "Couldn't reach the checker; the DNS result above still stands."));
    return;
  }
  if (d.error) {
    pending.replaceWith(verdict("", "Live HTTP/3 check skipped", escapeHtml(d.error) + "."));
    return;
  }

  const speaks = d.h3_handshake_ok;
  let kind = "", title = "", sub = "", extra = null;
  if (speaks && rrHasH3) {
    kind = "ok";
    title = "Speaks HTTP/3 ✓";
    sub = "Confirmed with a live HTTP/3 handshake. The HTTPS record above advertises h3 too, so clients reach HTTP/3 on the very first connection.";
  } else if (speaks && !rrHasH3) {
    kind = "warn";
    title = "Speaks HTTP/3, but it isn't in the HTTPS record";
    sub =
      "The server completes an HTTP/3 handshake" +
      (d.advertises_h3 ? " and sends <code>Alt-Svc: h3</code>" : "") +
      ", but the HTTPS record above doesn't advertise h3, so the first connection can't use HTTP/3. Publish one:";
    extra = publishHint(domain);
  } else if (d.advertises_h3) {
    kind = "warn";
    title = "Advertises h3 via Alt-Svc, but no handshake from our checker";
    sub = "The <code>Alt-Svc</code> header lists h3, but a live HTTP/3 handshake didn't complete from our checker (it may be geo/rate-limited or briefly down).";
  } else {
    title = "No HTTP/3 detected";
    sub = "No <code>Alt-Svc: h3</code> and no HTTP/3 handshake, so the server likely doesn't serve HTTP/3.";
  }

  const v = verdict(kind, title, sub, extra);
  const facts = el("ul", "facts");
  const yn = (b) => (b ? `<span class="pill h3">yes</span>` : `<span class="pill">no</span>`);
  const row = (k, val) => facts.append(el("li", null, `<span class="k">${k}</span><span class="val">${val}</span>`));
  row("Alt-Svc h3", yn(d.advertises_h3));
  row("HTTP/3 handshake", yn(d.h3_handshake_ok));
  if (d.quic_versions && d.quic_versions.length)
    row("QUIC versions", d.quic_versions.map((x) => `<span class="pill h3">${escapeHtml(x)}</span>`).join(" "));
  if (d.alt_svc) row("Alt-Svc", `<code>${escapeHtml(d.alt_svc)}</code>`);
  v.append(facts);
  pending.replaceWith(v);
}

/* ---- sharing ---- */

// Shareable permalink for a domain's result: ?d=<domain>#check
function shareUrl(domain) {
  const u = new URL(location.href);
  u.searchParams.set("d", domain);
  u.hash = "check";
  return u.href;
}

// Put the looked-up domain in the address bar so the page itself is shareable.
function updateUrl(domain) {
  try {
    const u = new URL(location.href);
    u.searchParams.set("d", domain);
    history.replaceState(null, "", u);
  } catch {}
}

// A truthful one-line verdict for the share text, from the resolved chain.
function shareSummary(domain, chain) {
  const { hops, finalName, out, status } = chain;
  const via = hops.length ? ` (via alias to ${finalName})` : "";
  if (status === "loop") return `${domain}'s HTTPS DNS record aliases in a loop and never resolves.`;
  if (status === "toodeep") return `${domain}'s HTTPS DNS record aliases too many times to resolve.`;
  if (status === "unavailable") return `${domain}'s HTTPS DNS record signals the service is not available.`;
  if (!out.records.length)
    return `${domain} publishes no usable HTTPS DNS record, so browsers can't use HTTP/3 on the first connection.`;
  if (out.records.some((r) => (r.params.alpn || []).includes("h3")))
    return `${domain} advertises HTTP/3 in its HTTPS DNS record${via}, so browsers can use HTTP/3 on the first connection.`;
  return `${domain} has an HTTPS DNS record${via} but doesn't advertise HTTP/3 (h3) in it.`;
}

// Mastodon has no central share endpoint (it's federated), so ask for the
// user's instance, remember it, and open that instance's /share composer.
function shareToMastodon(domain, summary) {
  let inst = "";
  try { inst = localStorage.getItem("masto-instance") || ""; } catch {}
  inst = (window.prompt("Your Mastodon instance:", inst || "mastodon.social") || "").trim();
  if (!inst) return;
  inst = inst.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  try { localStorage.setItem("masto-instance", inst); } catch {}
  const text = `${summary} ${shareUrl(domain)}`;
  window.open(`https://${inst}/share?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
}

function shareRow(domain, summary) {
  const row = el("div", "share-row");
  row.append(el("span", "share-label", "Share this result:"));

  const copy = el("button", "share-btn", "copy link");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(domain));
      copy.textContent = "copied ✓";
    } catch {
      copy.textContent = "copy failed";
    }
    setTimeout(() => (copy.textContent = "copy link"), 1500);
  });

  const masto = el("button", "share-btn", "share on Mastodon");
  masto.type = "button";
  masto.addEventListener("click", () => shareToMastodon(domain, summary));

  row.append(copy, masto);
  return row;
}

/* ---- wire-up ---- */

function init() {
  const form = document.getElementById("lookup-form");
  const input = document.getElementById("domain");
  const btn = document.getElementById("go");
  const result = document.getElementById("result");
  if (!form) return;

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

    updateUrl(domain);
    btn.disabled = true;
    result.setAttribute("aria-busy", "true");
    result.innerHTML = `<div class="spin">querying cloudflare-dns.com for ${domain} HTTPS …</div>`;
    try {
      const chain = await resolveChain(domain);
      render(domain, chain, result);
      const rrHasH3 =
        chain.status === "resolved" &&
        chain.out.records.some((r) => (r.params.alpn || []).includes("h3"));
      connectionChecks(domain, result, rrHasH3);
      result.append(shareRow(domain, shareSummary(domain, chain)));
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

  // shareable link: ?d=example.com (legacy: #lookup=example.com)
  const shared = new URL(location.href).searchParams.get("d");
  const legacy = location.hash.match(/lookup=([^&]+)/);
  const initial = shared || (legacy && decodeURIComponent(legacy[1]));
  if (initial) {
    run(initial);
    document.getElementById("check")?.scrollIntoView({ behavior: "smooth" });
  }
}

document.addEventListener("DOMContentLoaded", init);
