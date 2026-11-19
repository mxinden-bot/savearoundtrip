/* savearoundtrip: live HTTPS-RR lookup via Cloudflare DNS-over-HTTPS.
 *
 * Cloudflare's DoH JSON endpoint historically returned type-65 (HTTPS) records
 * as RFC 3597 "generic" RDATA, e.g.  "\# 61 00 01 00 00 01 00 06 02 68 33 ...",
 * which we decode from the SVCB/HTTPS wire format (RFC 9460 §2.2). From
 * 2026-07-28 it is switching to standard presentation format, e.g.
 * "1 . alpn=h3,h2 ipv4hint=192.0.2.1"; during the rollout either form may
 * appear, so we parse both (see parseGeneric vs parsePresentation).
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

// Cloudflare's DoH JSON is moving the `data` field from RFC 3597 generic hex to
// standard RFC 9460 presentation format for HTTPS/SVCB records (rolling out from
// 2026-07-28, either format possible mid-rollout). Parse that form too, into the
// same { priority, target, params } shape parseSvcb produces.
//   e.g.  1 . alpn="h3,h2" ipv4hint=192.0.2.1,192.0.2.2 ech=... no-default-alpn
function parsePresentation(data) {
  const s = data.trim();
  if (!s || s.startsWith("\\#")) return null; // empty or generic form

  // Split on whitespace, but keep quoted spans and honor "\" escapes intact.
  const toks = [];
  let cur = "", inQuote = false, started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; started = true; continue; }
    if (ch === '"') { inQuote = !inQuote; started = true; continue; }
    if (/\s/.test(ch) && !inQuote) { if (started) { toks.push(cur); cur = ""; started = false; } continue; }
    cur += ch; started = true;
  }
  if (started) toks.push(cur);

  // Some encoders prefix the RR type ("HTTPS 1 . ..."); drop a leading non-numeric.
  if (toks.length && Number.isNaN(parseInt(toks[0], 10))) toks.shift();
  if (toks.length < 2) return null;

  const priority = parseInt(toks[0], 10);
  if (Number.isNaN(priority)) return null;
  const target = toks[1];

  const params = {};
  const list = (v) => v.split(",").filter(Boolean);
  for (let i = 2; i < toks.length; i++) {
    const eq = toks[i].indexOf("=");
    const key = eq < 0 ? toks[i] : toks[i].slice(0, eq);
    const val = eq < 0 ? "" : toks[i].slice(eq + 1);
    switch (key) {
      case "alpn": params.alpn = list(val); break;
      case "no-default-alpn": params["no-default-alpn"] = true; break;
      case "port": params.port = parseInt(val, 10); break;
      case "ipv4hint": params.ipv4hint = list(val); break;
      case "ipv6hint": params.ipv6hint = list(val); break;
      case "ech": params.ech = echBytes(val); break;
      case "mandatory": params.mandatory = true; break;
      default: params[key] = val.length || true;
    }
  }
  return { priority, target, params };
}

// Byte length of a base64 ECHConfigList, to match parseSvcb's `ech = vlen`.
function echBytes(b64) {
  try { return atob(b64).length; } catch { return b64.length || true; }
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
    const rec = bytes ? parseSvcb(bytes) : parsePresentation(a.data);
    if (rec) records.push({ ...rec, ttl: a.TTL });
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

// Append the facts for one name's records to the HTTPS record box, labelling
// which name they came from when we followed an alias to get here.
function renderRecordFacts(records, ownerName, whereLabel, card) {
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

    card.append(facts);
  });
}

// The HTTPS record box: verdict, alias chain, record details and fix, all in one.
function render(domain, chain, target) {
  target.innerHTML = "";
  const { hops, finalName, out, status } = chain;
  const followed = hops.length > 0;
  const hasH3 = out.records.some((r) => (r.params.alpn || []).includes("h3"));
  const where = followed ? ` (via alias to <code>${escapeHtml(finalName)}</code>)` : "";

  let kind, title, sub, hintFor = null, showRecords = false;
  if (status === "loop") {
    kind = "err";
    title = "HTTPS alias loops";
    sub =
      `The AliasMode chain from <code>${escapeHtml(domain)}</code> points back to a ` +
      `name it already visited, so it never resolves to a service. RFC 9460 says the ` +
      `alias target must not loop; a browser stops here.`;
  } else if (status === "toodeep") {
    kind = "err";
    title = "HTTPS alias chain too long";
    sub =
      `Followed ${MAX_ALIAS_HOPS} AliasMode records without reaching a service. ` +
      `Browsers cap the chain (Firefox at ${MAX_ALIAS_HOPS}) and give up, so this ` +
      `record is effectively unusable.`;
  } else if (status === "unavailable") {
    kind = "warn";
    title = "Alias says the service is not available";
    sub =
      `<code>${escapeHtml(finalName)}</code> has an AliasMode record with target ` +
      `<code>.</code> (root), which RFC 9460 uses to signal that the service does ` +
      `not exist here. Clients may ignore it and connect normally.`;
  } else if (!out.records.length && followed) {
    kind = "warn";
    title = "Alias target has no HTTPS record";
    sub =
      `<code>${escapeHtml(domain)}</code> aliases to <code>${escapeHtml(finalName)}</code>, ` +
      `but that name publishes no HTTPS record, so there's no HTTP/3 to discover from DNS. ` +
      `Browsers fall back to its A/AAAA addresses. Publish an HTTPS record at the target:`;
    hintFor = finalName;
  } else if (!out.records.length) {
    kind = "warn";
    title = "No HTTPS record published";
    sub =
      `<code>${escapeHtml(domain)}</code> has no HTTPS DNS record. If it serves HTTP/3, ` +
      `browsers can only discover that <i>after</i> a first connection (via the ` +
      `<code>Alt-Svc</code> HTTP header), so the first connection can't use it. ` +
      `Publishing a record with <code>alpn="h3"</code> fixes that.`;
    hintFor = domain;
  } else if (hasH3) {
    kind = "ok";
    title = "HTTPS record found: advertises HTTP/3 &#10003;";
    sub = `Browsers can negotiate HTTP/3 on the <b>first</b> connection${where}. No round trip wasted.`;
    showRecords = true;
  } else {
    kind = "warn";
    title = "HTTPS record found, but no HTTP/3 in it";
    sub =
      `The record${where} doesn't list <code>h3</code>, so clients won't ` +
      `try HTTP/3 from DNS. Add <code>h3</code> to the <code>alpn</code> set.`;
    hintFor = finalName;
    showRecords = true;
  }

  const card = verdict(kind, title, sub);
  if (followed) card.append(aliasTrace(domain, hops));
  if (showRecords) renderRecordFacts(out.records, finalName, followed, card);
  if (hintFor) card.append(publishHint(hintFor));
  target.append(card);
  return hintFor !== null;
}

function verdict(kind, title, sub, extra) {
  const c = el("div", `verdict-card ${kind}`);
  c.append(el("div", "v-title", title));
  c.append(el("div", "v-sub", sub));
  if (extra) c.append(extra);
  return c;
}

function pendingCard(text) {
  const c = el("div", "verdict-card");
  c.append(el("div", "v-sub", `<span class="spin">${text}</span>`));
  return c;
}

function factList() {
  const facts = el("ul", "facts");
  const row = (k, val) => facts.append(el("li", null, `<span class="k">${k}</span><span class="val">${val}</span>`));
  return [facts, row];
}

const yn = (b) => (b ? `<span class="pill h3">yes</span>` : `<span class="pill">no</span>`);

/* ---- the checklist: what a domain advertises to browsers for HTTP/3 ---- */

// [key, item, what to do when missing, how-to anchor]
const CHECKLIST = [
  ["h3", "Serves HTTP/3", "Enable HTTP/3 next to HTTP/2, with UDP port 443 open.", "support"],
  ["altsvc", "Advertises HTTP/3 in the <code>Alt-Svc</code> HTTP header", `Send <code>Alt-Svc: h3=":443"; ma=86400</code> on every response.`, "signal-altsvc"],
  ["rr", "Advertises HTTP/3 in an HTTPS DNS record", `Publish an HTTPS record with <code>alpn="h3"</code>.`, "signal-rr"],
  ["zerortt", "QUIC 0-RTT for repeat visits", "Enable QUIC 0-RTT.", "signal-0rtt"],
];
const MARK = { ok: "✓", todo: "✗", na: "–", unknown: "?", pending: "" };

function checklist(domain) {
  const card = el("div", "checklist");
  card.append(el("div", "cl-head", `HTTP/3 checklist for <code>${escapeHtml(domain)}</code> <span class="cl-count"></span>`));
  const list = el("ul", "cl-list");
  card.append(list);
  const items = {}, state = {};
  for (const [key, label] of CHECKLIST) {
    const li = el("li", "cl-item pending", `<span class="cl-mark" aria-hidden="true"></span><span class="cl-text">${label}<span class="cl-note"></span></span>`);
    list.append(li);
    items[key] = li;
    state[key] = "pending";
  }
  const count = card.querySelector(".cl-count");
  const update = () => {
    const done = Object.values(state).filter((s) => s === "ok").length;
    count.textContent = Object.values(state).includes("pending") ? "checking" : `${done} of ${CHECKLIST.length} done`;
  };
  update();
  return {
    el: card,
    set(key, s, note) {
      const [, , fix, anchor] = CHECKLIST.find((c) => c[0] === key);
      const li = items[key];
      state[key] = s;
      li.className = `cl-item ${s}`;
      li.querySelector(".cl-mark").textContent = MARK[s];
      li.querySelector(".cl-note").innerHTML = s === "todo" ? `${fix} <a href="#${anchor}">How</a>` : note || "";
      update();
    },
  };
}

// Asks the backend for each check separately and at once (Alt-Svc, QUIC v1,
// QUIC v2), so each checklist item and box fills in as soon as its own answer
// arrives. "Serves HTTP/3" and 0-RTT come from the v1 handshake, the version
// browsers start with; v2 only adds to the QUIC versions row. If neither the
// Alt-Svc nor the v1 request gets an answer, the backend predates the
// per-check endpoints (or is down): fall back to the single /check.
async function connectionChecks(domain, target, rrHasH3, hintShown, cl) {
  const altPending = pendingCard("checking the Alt-Svc header");
  const h3Pending = pendingCard("trying a live HTTP/3 handshake");
  target.append(altPending, h3Pending);

  const q = encodeURIComponent(domain);
  // null when the request itself failed: unreachable, blocked, or not JSON
  const get = (path) =>
    fetch(`${CHECK_API}${path}`, { cache: "no-store" })
      .then((r) => ((r.headers.get("content-type") || "").includes("json") ? r.json() : null))
      .catch(() => null);
  const altP = get(`/altsvc?domain=${q}`);
  const v1P = get(`/h3?v=1&domain=${q}`);
  const v2P = get(`/h3?v=2&domain=${q}`);

  const showAlt = (a) => {
    if (a.error) {
      cl.set("altsvc", "unknown", escapeHtml(a.error) + ".");
      altPending.replaceWith(verdict("", "Alt-Svc check skipped", escapeHtml(a.error) + "."));
      return;
    }
    cl.set("altsvc", a.advertises_h3 ? "ok" : "todo");
    altPending.replaceWith(altSvcBox(a, rrHasH3));
  };
  let h3Card = null;
  const showH3 = (h, a) => {
    if (h.error) {
      ["h3", "zerortt"].forEach((k) => cl.set(k, "unknown", escapeHtml(h.error) + "."));
      h3Pending.replaceWith(verdict("", "HTTP/3 check skipped", escapeHtml(h.error) + "."));
      return;
    }
    const speaks = h.h3_handshake_ok;
    const d = { ...h, advertises_h3: !!(a && a.advertises_h3), quic_versions: speaks ? ["v1"] : [] };
    setH3Items(cl, d, rrHasH3);
    h3Card = h3Box(d, domain, rrHasH3, hintShown, speaks);
    h3Pending.replaceWith(h3Card);
  };

  const [alt, v1] = await Promise.all([
    altP.then((a) => {
      if (a) showAlt(a);
      return a;
    }),
    v1P.then(async (h) => {
      if (!h) return h;
      // the wording without a handshake depends on whether Alt-Svc advertised HTTP/3
      showH3(h, h.error || h.h3_handshake_ok ? null : await altP);
      return h;
    }),
  ]);

  if (!alt && !v1) return legacyChecks(domain, altPending, h3Pending, rrHasH3, hintShown, cl);
  if (!alt) {
    cl.set("altsvc", "unknown", "Couldn't reach the checker.");
    altPending.replaceWith(verdict("", "Alt-Svc check unavailable", "Couldn't reach the checker."));
  }
  if (!v1) {
    ["h3", "zerortt"].forEach((k) => cl.set(k, "unknown", "Couldn't reach the checker."));
    h3Pending.replaceWith(verdict("", "HTTP/3 check unavailable", "Couldn't reach the checker."));
  }

  const v2 = await v2P;
  const pending = h3Card && h3Card.querySelector(".qv-pending");
  if (pending) {
    if (v2 && v2.h3_handshake_ok) pending.outerHTML = `<span class="pill h3">v2</span>`;
    else pending.remove();
  }
}

// The checklist items that come from the HTTP/3 check.
function setH3Items(cl, d, rrHasH3) {
  const speaks = d.h3_handshake_ok;
  if (speaks) cl.set("h3", "ok");
  else if (d.advertises_h3 || rrHasH3) cl.set("h3", "unknown", "Advertised, but the live handshake from our checker didn't complete.");
  else cl.set("h3", "todo");
  if (!speaks) cl.set("zerortt", "na", "Needs HTTP/3 first.");
  else if (d.zero_rtt) cl.set("zerortt", d.zero_rtt.early_data ? "ok" : "todo");
  else cl.set("zerortt", "unknown", "Not checked.");
}

// One request for everything, for a backend without the per-check endpoints.
async function legacyChecks(domain, altPending, h3Pending, rrHasH3, hintShown, cl) {
  const unknown = (note) => ["h3", "altsvc", "zerortt"].forEach((k) => cl.set(k, "unknown", note));
  let d;
  try {
    const r = await fetch(`${CHECK_API}?domain=${encodeURIComponent(domain)}`, { cache: "no-store" });
    d = await r.json();
  } catch {
    altPending.remove();
    h3Pending.replaceWith(verdict("", "Live checks unavailable", "Couldn't reach the checker; the DNS result above still stands."));
    unknown("Couldn't reach the checker.");
    return;
  }
  if (d.error) {
    altPending.remove();
    h3Pending.replaceWith(verdict("", "Live checks skipped", escapeHtml(d.error) + "."));
    unknown(escapeHtml(d.error) + ".");
    return;
  }
  setH3Items(cl, d, rrHasH3);
  cl.set("altsvc", d.advertises_h3 ? "ok" : "todo");
  altPending.replaceWith(altSvcBox(d, rrHasH3));
  h3Pending.replaceWith(h3Box(d, domain, rrHasH3, hintShown));
}

function altSvcBox(d, rrHasH3) {
  let kind = "", title, sub;
  if (d.advertises_h3) {
    kind = "ok";
    title = "Alt-Svc header advertises HTTP/3 &#10003;";
    sub =
      "Browsers that connect over HTTP/2 or HTTP/1.1 learn from this response header " +
      "that HTTP/3 is available, and use it from the next connection on.";
  } else {
    title = d.alt_svc ? "Alt-Svc header doesn't advertise HTTP/3" : "No Alt-Svc header";
    sub = rrHasH3
      ? "Browsers learn about HTTP/3 from the HTTPS record above instead."
      : "Browsers can't discover HTTP/3 from the response headers.";
  }
  const v = verdict(kind, title, sub);
  if (d.alt_svc) {
    const [facts, row] = factList();
    row("header", `<code>${escapeHtml(d.alt_svc)}</code>`);
    v.append(facts);
  }
  return v;
}

function h3Box(d, domain, rrHasH3, hintShown, v2Pending = false) {
  const speaks = d.h3_handshake_ok;
  let kind = "", title, sub, extra = null;
  if (speaks && rrHasH3) {
    kind = "ok";
    title = "Speaks HTTP/3 &#10003;";
    sub = "Confirmed with a live HTTP/3 handshake. The HTTPS record above advertises HTTP/3 too, so clients reach HTTP/3 on the very first connection.";
  } else if (speaks) {
    kind = "warn";
    title = "Speaks HTTP/3, but it isn't in the HTTPS record";
    sub = "The server completes an HTTP/3 handshake, but no HTTPS record advertises HTTP/3, so the first connection can't use HTTP/3.";
    if (hintShown) {
      sub += " Publishing the record above fixes that.";
    } else {
      sub += " Publish one:";
      extra = publishHint(domain);
    }
  } else if (d.advertises_h3 || rrHasH3) {
    kind = "warn";
    title = "No HTTP/3 handshake from our checker";
    sub =
      `The ${rrHasH3 ? "HTTPS record" : "<code>Alt-Svc</code> header"} lists HTTP/3, but a live HTTP/3 handshake ` +
      "didn't complete from our checker (it may be geo/rate-limited or briefly down).";
  } else {
    title = "No HTTP/3 detected";
    sub = "Nothing advertises HTTP/3 and no HTTP/3 handshake completed, so the server likely doesn't serve HTTP/3.";
  }

  const v = verdict(kind, title, sub, extra);
  const [facts, row] = factList();
  row("HTTP/3 handshake", yn(speaks));
  if (d.quic_versions && d.quic_versions.length)
    row(
      "QUIC versions",
      d.quic_versions.map((x) => `<span class="pill h3">${escapeHtml(x)}</span>`).join(" ") +
        (v2Pending ? ` <span class="pill qv-pending">checking v2</span>` : "")
    );
  if (d.zero_rtt) {
    row("Session resumption", yn(d.zero_rtt.ticket_issued));
    row("0-RTT enabled", yn(d.zero_rtt.early_data));
  }
  v.append(facts);
  if (d.transport_params && Object.keys(d.transport_params).length)
    v.append(transportParamsDetails(d.transport_params));
  return v;
}

// quic-go's qlog reports byte-count params in bytes and duration params in
// milliseconds; the raw numbers carry no units, so we annotate them.
const TP_BYTES = new Set([
  "initial_max_data",
  "initial_max_stream_data_bidi_local",
  "initial_max_stream_data_bidi_remote",
  "initial_max_stream_data_uni",
  "max_udp_payload_size",
  "max_datagram_frame_size",
]);
const TP_MS = new Set(["max_idle_timeout", "max_ack_delay"]);

function humanBytes(n) {
  if (n < 1024) return `${n} bytes`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n, i = -1;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${n} (${Math.round(v * 10) / 10} ${units[i]})`;
}

function humanMs(n) {
  return n >= 1000 ? `${n} ms (${Math.round(n / 100) / 10} s)` : `${n} ms`;
}

// The server's QUIC transport parameters (RFC 9000 §18), tucked into a collapsed
// <details> since they're only tangentially related to the h3 question.
function transportParamsDetails(tp) {
  const keys = Object.keys(tp).sort();
  const d = el("details", "tp-details");
  d.append(el("summary", null, `QUIC transport parameters <span class="tp-count">${keys.length}</span>`));
  const list = el("ul", "facts tp-facts");
  for (const k of keys) {
    const raw = tp[k];
    let val;
    if (typeof raw === "boolean") val = raw ? "yes" : "no";
    else if (typeof raw === "number" && TP_BYTES.has(k)) val = humanBytes(raw);
    else if (typeof raw === "number" && TP_MS.has(k)) val = humanMs(raw);
    else val = String(raw);
    list.append(el("li", null, `<span class="k"><code>${escapeHtml(k)}</code></span><span class="val">${escapeHtml(val)}</span>`));
  }
  d.append(list);
  return d;
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
  return `${domain} has an HTTPS DNS record${via} but doesn't advertise HTTP/3 in it.`;
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
      const hintShown = render(domain, chain, result);
      const rrHasH3 =
        chain.status === "resolved" &&
        chain.out.records.some((r) => (r.params.alpn || []).includes("h3"));
      const cl = checklist(domain);
      result.prepend(cl.el, el("div", "result-sub", "details"));
      cl.set("rr", rrHasH3 ? "ok" : "todo");
      connectionChecks(domain, result, rrHasH3, hintShown, cl);
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
