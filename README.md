# savearoundtrip

A small, geeky, single-page site advocating for publishing **HTTPS DNS
resource records** (RFC 9460) so browsers can discover HTTP/3 and connect
optimally on the *first* connection, instead of wasting a round trip
re-connecting after reading an `Alt-Svc` header.

> Many sites send `Alt-Svc: h3=":443"` but publish **no HTTPS RR**. That means
> the browser connects over HTTP/2 (TCP+TLS), reads the header, and only
> *then* knows it could have used HTTP/3 (QUIC). The HTTP/3 upgrade happens on
> the *next* connection. Publish an HTTPS RR with `alpn="h3"` and the client
> goes straight to QUIC on connection #1. One less round trip.

## What's here

```
index.html              the whole site (landing + explainer + live lookup tool)
css/style.css           monospace / terminal aesthetic
js/lookup.js            Cloudflare DoH (DNS-over-HTTPS) HTTPS-RR lookup + wire parser
js/charts.js            renders the real-browser numbers from data/glam.json
scripts/fetch-glam.mjs  CI script: pulls the Happy Eyeballs probes from GLAM
.github/workflows/glam.yml  daily job that refreshes data/glam.json
data/glam.json          headline numbers, measured in Firefox (committed by CI)
data/stats.json         placeholder for a future offline domain-scan metric
```

It's a static site. No build step, no dependencies, no tracker. Open
`index.html` in a browser, or serve the directory:

```
python3 -m http.server 8000
# then visit http://localhost:8000
```

## The live lookup tool

Type a domain and the page queries Cloudflare's DoH JSON endpoint
(`https://cloudflare-dns.com/dns-query?type=HTTPS`) entirely from your
browser, then decodes the binary SVCB/HTTPS RDATA (Cloudflare returns it in
RFC 3597 generic `\# <len> <hex>` form) to show:

- whether an **HTTPS RR exists** at all,
- the advertised **ALPN** set (is `h3` in there?),
- **IP hints** (`ipv4hint` / `ipv6hint`),
- whether **ECH** (Encrypted Client Hello) is configured,
- priority / target / port and any other SvcParams.

> Note on `Alt-Svc`: a page can't read another origin's response headers from
> the browser (CORS forbids it), so the in-browser tool focuses on what *is*
> observable client-side: the DNS record. The "Alt-Svc but no HTTPS RR" gap
> is the job of the offline measurement pipeline (see below).

## Why HTTPS RR beats Alt-Svc (the short version)

| | `Alt-Svc` header (RFC 7838) | HTTPS RR (RFC 9460) |
|---|---|---|
| When is it learned? | *After* a full TCP+TLS+HTTP connection | During DNS resolution, *before* connecting |
| First-connection h3? | No, needs a prior connection | **Yes** |
| Carries IP hints? | No | **Yes** (`ipv4hint`/`ipv6hint`) |
| Carries ECH keys? | No | **Yes** (`ech`) |
| Multiple ALPNs? | One value | **Yes** |
| Works at the zone apex? | n/a | **Yes** (AliasMode, no CNAME) |
| Source of truth | Header + fragile cache | The DNS, authoritatively |

Full write-up with RFC citations is on the page itself.

## The data: real-browser numbers from GLAM

The headline number and the two bar charts come from Firefox itself, via
Mozilla's public [GLAM](https://glam.telemetry.mozilla.org/) telemetry, using
two Happy Eyeballs probes (`netwerk_happy_eyeballs_h3_discovery` and
`netwerk_happy_eyeballs_https_rr_features`).

GLAM's API can't be called from the browser (it sends no CORS header and
`X-Frame-Options: DENY`), so we don't. Instead a daily GitHub Action
(`.github/workflows/glam.yml`) runs `scripts/fetch-glam.mjs`, which queries
GLAM **server-side** (where the Same-Origin Policy doesn't apply), computes the
shares, and commits `data/glam.json`. GitHub Pages then serves that as a plain,
same-origin file the page reads with a normal `fetch`. So the site stays fully
static at visit time; the only thing that ever touches GLAM is CI.

Run it on demand instead of waiting for the daily cron: the workflow has a
`workflow_dispatch` trigger, so you can start it from the repo's **Actions** tab
("refresh GLAM data" -> "Run workflow"), or with `gh workflow run glam.yml`.

The headline is **`altsvc_only / (altsvc_only + both + https_rr_only)`**: of the
connections where the origin supports h3, the share that learned it only from an
`Alt-Svc` header (no usable HTTPS record), and so reached HTTP/3 only on a later
connection. If the fetch ever fails, the last committed `data/glam.json` stays
in place and the page keeps showing it. The GLAM HTTP API is undocumented, so
treat it as best-effort.

### Possible future addition: an offline domain scan

A complementary angle would be a periodic scan over a domain list (Tranco Top
1M is the standard), recording per domain:

1. does it send `Alt-Svc` advertising `h3`?
2. does it publish an HTTPS RR (and does that RR include `alpn="h3"`)?

The interesting population is **(1) AND NOT (2)**: sites that *want* HTTP/3
but force a wasted round trip to get there. That would write `data/stats.json`.
Prior art (one-off scans, no live tracker exists):

- Zirngibl, Sattler, Carle: *"A First Look at SVCB and HTTPS DNS Resource
  Records in the Wild"*, WTMC 2023 (TUM).
- Dong & Zhang et al.: *"Exploring the Ecosystem of DNS HTTPS Resource
  Records"*, arXiv:2403.15672.
- APNIC blog, Dec 2023: one-shot scan of ~227M domains + Tranco Top 1M.

## References

- RFC 9460: Service Binding and Parameter Specification via the DNS (SVCB / HTTPS RRs)
- RFC 7838: HTTP Alternative Services (`Alt-Svc`)
- RFC 9114: HTTP/3
- RFC 8305: Happy Eyeballs v2
- draft-ietf-tls-esni: TLS Encrypted Client Hello (ECH)
- draft-thomson-httpbis-alt-svcb-00: "HTTP Alternative Services, Plan B"
