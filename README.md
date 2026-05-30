# savearoundtrip

A small, geeky, single-page site advocating for publishing **HTTPS DNS
resource records** (RFC 9460) so browsers can discover HTTP/3 and connect
optimally on the *first* connection — instead of wasting a round trip
re-connecting after reading an `Alt-Svc` header.

> Many sites send `Alt-Svc: h3=":443"` but publish **no HTTPS RR**. That means
> the browser connects over HTTP/2 (TCP+TLS), reads the header, and only
> *then* knows it could have used HTTP/3 (QUIC). The HTTP/3 upgrade happens on
> the *next* connection. Publish an HTTPS RR with `alpn="h3"` and the client
> goes straight to QUIC on connection #1. One less round trip.

## What's here

```
index.html        the whole site (landing + explainer + live lookup tool)
css/style.css     monospace / terminal aesthetic
js/lookup.js      Cloudflare DoH (DNS-over-HTTPS) HTTPS-RR lookup + wire parser
data/stats.json   placeholder for the headline measurement metric
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
> observable client-side — the DNS record. The "Alt-Svc but no HTTPS RR" gap
> is the job of the offline measurement pipeline (see below).

## Why HTTPS RR beats Alt-Svc (the short version)

| | `Alt-Svc` header (RFC 7838) | HTTPS RR (RFC 9460) |
|---|---|---|
| When is it learned? | *After* a full TCP+TLS+HTTP connection | During DNS resolution, *before* connecting |
| First-connection h3? | No — needs a prior connection | **Yes** |
| Carries IP hints? | No | **Yes** (`ipv4hint`/`ipv6hint`) |
| Carries ECH keys? | No | **Yes** (`ech`) |
| Multiple ALPNs? | One value | **Yes** |
| Works at the zone apex? | n/a | **Yes** (AliasMode, no CNAME) |
| Source of truth | Header + fragile cache | The DNS, authoritatively |

Full write-up with RFC citations is on the page itself.

## The measurement pipeline (TODO)

The headline number is meant to be fed by a periodic offline job that, over a
domain list (Tranco Top 1M is the standard), records per domain:

1. does it send `Alt-Svc` advertising `h3`?
2. does it publish an HTTPS RR (and does that RR include `alpn="h3"`)?

The interesting population is **(1) AND NOT (2)** — sites that *want* HTTP/3
but force a wasted round trip to get there. The job writes `data/stats.json`;
the page renders it. Prior art (one-off scans, no live tracker exists):

- Zirngibl, Sattler, Carle — *"A First Look at SVCB and HTTPS DNS Resource
  Records in the Wild"*, WTMC 2023 (TUM).
- Dong & Zhang et al. — *"Exploring the Ecosystem of DNS HTTPS Resource
  Records"*, arXiv:2403.15672.
- APNIC blog, Dec 2023 — one-shot scan of ~227M domains + Tranco Top 1M.

## References

- RFC 9460 — Service Binding and Parameter Specification via the DNS (SVCB / HTTPS RRs)
- RFC 7838 — HTTP Alternative Services (`Alt-Svc`)
- RFC 9114 — HTTP/3
- RFC 8305 — Happy Eyeballs v2
- draft-ietf-tls-esni — TLS Encrypted Client Hello (ECH)
- draft-thomson-httpbis-alt-svcb-00 — "HTTP Alternative Services, Plan B"
