# check-service

Tiny Go service the page calls to do the two checks a browser can't:

- **Alt-Svc** (advertised h3): fetch the origin over HTTP/2/1.1 and read its `Alt-Svc` header.
- **HTTP/3 handshake** (actually speaks h3): complete a real QUIC/HTTP-3 connection
  with [`quic-go`](https://github.com/quic-go/quic-go). Needs outbound UDP, which is
  why it runs on Fly.io (Cloudflare Workers/Containers don't allow outbound UDP).

```
GET /check?domain=example.com
-> { "domain", "alt_svc", "advertises_h3", "h3_handshake_ok" }
```

Guards: https-only, hostname validation, SSRF block on private/loopback IPs,
per-request timeout, global concurrency cap. CORS is `*` (read-only, no secrets).

## Deploy (Fly.io)

From the Fly dashboard "Launch an App from GitHub" (repo `mxinden-bot/savearoundtrip`):

- App name: `savearoundtrip-check`
- Working directory: `check-service`
- Config path: `check-service/fly.toml`
- Internal port: `8080`
- Machine: shared-cpu-1x, 256MB
- Region: `fra` (or nearest)

Then the service is at `https://savearoundtrip-check.fly.dev`. Or via CLI:

```
cd check-service && fly launch --no-deploy && fly deploy
```

## Verify QUIC egress works on Fly

```
curl -s "https://savearoundtrip-check.fly.dev/check?domain=cloudflare.com"
# expect: "h3_handshake_ok": true
```
