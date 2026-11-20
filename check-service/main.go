// savearoundtrip connection checker.
//
// The page asks for each check separately and in parallel, so every checklist
// item appears as soon as its own check is done:
//
//	GET /check/altsvc?domain=example.com   { "domain", "alt_svc", "advertises_h3", "error" }
//	GET /check/h3?v=1&domain=example.com   { "domain", "version", "h3_handshake_ok", "transport_params", "zero_rtt", "error" }
//	GET /check/h3?v=2&domain=example.com   (the same, for QUIC v2)
//	GET /check/0rtt?domain=example.com     { "domain", "query", "plain" }
//
// /check/0rtt resumes a session and sends GET /?utm_source=savearoundtrip
// ("query") and GET / ("plain") as QUIC 0-RTT early data, each reporting
// "sent", "accepted" (the server took the early data) and the HTTP "status".
//
// GET /check?domain=example.com runs all of them and answers once, for pages
// that predate the split:
//
//	{ "domain", "alt_svc", "advertises_h3", "h3_handshake_ok", "quic_versions", "transport_params", "zero_rtt", "error" }
//
// - advertises_h3:  fetched the origin over HTTP/2/1.1 and its Alt-Svc header lists h3
// - h3_handshake_ok: completed a real QUIC/HTTP-3 handshake to the origin (proof it speaks h3)
// - quic_versions:  which QUIC versions completed an h3 handshake, e.g. ["v1","v2"]
// - transport_params: the server's QUIC transport parameters, by name (RFC 9000 §18)
// - zero_rtt:       whether the server issues a resumption ticket, and whether it permits 0-RTT
//
// This is the piece a browser can't do (CORS blocks reading Alt-Svc; browsers
// can't force a cold h3 handshake). Runs on Fly.io where outbound UDP/QUIC works.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/quic-go/qlog"
	"github.com/quic-go/quic-go/qlogwriter"
	"github.com/quic-go/quic-go/qlogwriter/jsontext"
)

const opTimeout = 6 * time.Second

var hostRe = regexp.MustCompile(`^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$`)

// global concurrency cap so the tiny machine can't be overwhelmed; a check from
// the page is three requests (Alt-Svc, QUIC v1, QUIC v2)
var sem = make(chan struct{}, 72)

type result struct {
	Domain          string         `json:"domain"`
	AltSvc          string         `json:"alt_svc,omitempty"`
	AdvertisesH3    bool           `json:"advertises_h3"`
	H3HandshakeOK   bool           `json:"h3_handshake_ok"`
	QuicVersions    []string       `json:"quic_versions,omitempty"`
	TransportParams map[string]any `json:"transport_params,omitempty"`
	ZeroRTT         *zeroRTT       `json:"zero_rtt,omitempty"`
	Error           string         `json:"error,omitempty"`
}

// zeroRTT reports whether the server, during the handshake, hands us a TLS
// session ticket (resumption possible) and whether that ticket permits early
// data, i.e. advertises 0-RTT for a future connection. We do not perform the
// 0-RTT resumption itself; this is purely what the server offers.
type zeroRTT struct {
	TicketIssued bool `json:"ticket_issued"`
	EarlyData    bool `json:"early_data"`
}

// ticketProbe is a tls.ClientSessionCache that records the post-handshake
// NewSessionTicket instead of storing it for reuse. Setting it on the TLS
// config is also what makes the client request a resumption ticket at all.
type ticketProbe struct {
	mu        sync.Mutex
	issued    bool
	earlyData bool
	got       chan struct{}
	once      sync.Once
}

func newTicketProbe() *ticketProbe { return &ticketProbe{got: make(chan struct{})} }

func (t *ticketProbe) Get(string) (*tls.ClientSessionState, bool) { return nil, false }

func (t *ticketProbe) Put(_ string, cs *tls.ClientSessionState) {
	if cs == nil {
		return
	}
	t.mu.Lock()
	t.issued = true
	// crypto/tls sets SessionState.EarlyData for a QUIC ticket exactly when the
	// server advertised max_early_data_size = 0xffffffff (RFC 9001 §4.6.1).
	if _, st, err := cs.ResumptionState(); err == nil && st != nil && st.EarlyData {
		t.earlyData = true
	}
	t.mu.Unlock()
	t.once.Do(func() { close(t.got) })
}

func (t *ticketProbe) result() *zeroRTT {
	t.mu.Lock()
	defer t.mu.Unlock()
	return &zeroRTT{TicketIssued: t.issued, EarlyData: t.earlyData}
}

// tpCapture pulls the peer's QUIC transport parameters out of quic-go's qlog
// stream. quic-go v0.60 no longer exposes them via a typed callback, so we act
// as a minimal qlog trace: on the "transport:parameters_set" event with
// initiator=remote (the server's params, received during the handshake), we
// re-encode it to JSON and keep the resulting name->value map.
type tpCapture struct {
	mu     sync.Mutex
	params map[string]any
}

func (t *tpCapture) get() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.params
}

func (t *tpCapture) AddProducer() qlogwriter.Recorder { return &tpRecorder{capture: t} }
func (t *tpCapture) SupportsSchemas(string) bool      { return true }

type tpRecorder struct{ capture *tpCapture }

func (r *tpRecorder) Close() error { return nil }

func (r *tpRecorder) RecordEvent(e qlogwriter.Event) {
	ps, ok := e.(qlog.ParametersSet)
	if !ok || ps.Restore || ps.Initiator != qlog.InitiatorRemote {
		return
	}
	var buf bytes.Buffer
	if err := ps.Encode(jsontext.NewEncoder(&buf), time.Time{}); err != nil {
		return
	}
	m := map[string]any{}
	if json.Unmarshal(buf.Bytes(), &m) != nil {
		return
	}
	delete(m, "initiator") // internal qlog field, not a transport parameter
	r.capture.mu.Lock()
	r.capture.params = m
	r.capture.mu.Unlock()
}

const ua = "savearoundtrip-check/1.0 (+https://savearoundtrip.com)"

// Browsers from these origins may read the response. Other sites can't embed
// this endpoint (the request still works from curl etc.; CORS only gates browsers).
var allowedOrigins = map[string]bool{
	"https://savearoundtrip.com":     true,
	"https://www.savearoundtrip.com": true,
}

// Cloudflare branch previews of the site, e.g.
// https://claude-offer-and-race-savearoundtrip.mail-f1c.workers.dev. Only the
// site's own Cloudflare account can create names under this subdomain.
const previewSuffix = "-savearoundtrip.mail-f1c.workers.dev"

func originAllowed(origin string) bool {
	if allowedOrigins[origin] {
		return true
	}
	name, ok := strings.CutPrefix(origin, "https://")
	return ok && strings.HasSuffix(name, previewSuffix) && !strings.ContainsAny(name, "/:@")
}

func setCORS(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); originAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	w.Header().Set("Vary", "Origin")
}

// reject anything that doesn't resolve to a public address (SSRF guard)
func publicResolvable(host string) error {
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return fmt.Errorf("DNS resolution failed")
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
			ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return fmt.Errorf("resolves to a non-public address")
		}
	}
	return nil
}

func checkAltSvc(ctx context.Context, host string) (string, bool) {
	c := &http.Client{Timeout: opTimeout}
	do := func(method string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(ctx, method, "https://"+host+"/", nil)
		req.Header.Set("User-Agent", ua)
		return c.Do(req)
	}
	resp, err := do(http.MethodHead)
	if err != nil {
		if resp, err = do(http.MethodGet); err != nil {
			return "", false
		}
	}
	defer resp.Body.Close()
	as := resp.Header.Get("Alt-Svc")
	return as, strings.Contains(as, "h3")
}

// Probe HTTP/3 by attempting a handshake pinned to each QUIC version we know,
// all versions in parallel.
// Returns whether any completed, the list of supported versions (v1/v2), and
// the server's transport parameters from the first version that handshook.
func checkH3(ctx context.Context, host string) (bool, []string, map[string]any, *zeroRTT) {
	probes := []struct {
		ver  quic.Version
		name string
	}{
		{quic.Version1, "v1"},
		{quic.Version2, "v2"},
	}
	type result struct {
		ok     bool
		params map[string]any
		zr     *zeroRTT
	}
	results := make([]result, len(probes))
	var wg sync.WaitGroup
	for i, p := range probes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i].ok, results[i].params, results[i].zr = tryH3(ctx, host, p.ver)
		}()
	}
	wg.Wait()

	var versions []string
	var tp map[string]any
	var zr *zeroRTT
	for i, r := range results {
		if r.ok {
			versions = append(versions, probes[i].name)
			if tp == nil {
				tp = r.params
			}
			if zr == nil {
				zr = r.zr
			}
		}
	}
	return len(versions) > 0, versions, tp, zr
}

// ticketWait bounds how long we linger after the response for the server's
// post-handshake NewSessionTicket. Most servers send it immediately, so the
// channel usually fires well before this.
const ticketWait = 1500 * time.Millisecond

func tryH3(ctx context.Context, host string, v quic.Version) (bool, map[string]any, *zeroRTT) {
	tpc := &tpCapture{}
	tkt := newTicketProbe()
	tr := &http3.Transport{
		TLSClientConfig: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS13, ClientSessionCache: tkt},
		QUICConfig: &quic.Config{
			Versions: []quic.Version{v},
			Tracer: func(context.Context, bool, quic.ConnectionID) qlogwriter.Trace {
				return tpc
			},
		},
	}
	defer tr.Close()
	c := &http.Client{Transport: tr, Timeout: opTimeout}
	do := func(method string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(ctx, method, "https://"+host+"/", nil)
		req.Header.Set("User-Agent", ua)
		return c.Do(req)
	}
	resp, err := do(http.MethodHead)
	if err != nil {
		if resp, err = do(http.MethodGet); err != nil {
			return false, nil, nil
		}
	}
	resp.Body.Close()
	// The NewSessionTicket is a post-handshake message; give it a moment to land
	// while the connection is still open.
	select {
	case <-tkt.got:
	case <-time.After(ticketWait):
	case <-ctx.Done():
	}
	return resp.ProtoMajor == 3, tpc.get(), tkt.result()
}

// earlyQuery is the query string the 0-RTT check adds. Sites, caches and CDNs
// commonly ignore UTM tracking parameters, so it shouldn't change the response.
const earlyQuery = "utm_source=savearoundtrip"

// earlyGet is one GET sent as QUIC 0-RTT early data on a resumed connection.
type earlyGet struct {
	Path string `json:"path"`
	// Sent says a ticket permitting early data was available, so the request
	// went out in 0-RTT.
	Sent bool `json:"sent"`
	// Accepted says the server accepted the early data (TLS level).
	Accepted bool `json:"accepted"`
	// Status is the HTTP status of the response, e.g. 425 Too Early.
	Status int    `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}

// sessionCache stores tickets like any client session cache and signals when
// one that permits early data arrives.
type sessionCache struct {
	tls.ClientSessionCache
	probe *ticketProbe
}

func (c *sessionCache) Put(key string, cs *tls.ClientSessionState) {
	c.ClientSessionCache.Put(key, cs)
	c.probe.Put(key, cs)
}

// tryEarlyGet gets a session ticket from a full handshake, then resumes with
// it and sends GET path as 0-RTT early data. Each call uses its own ticket, so
// servers that accept a ticket for early data only once don't skew the result.
func tryEarlyGet(ctx context.Context, host, path string) earlyGet {
	return earlyGetAt(ctx, host, host+":443", path, nil)
}

func earlyGetAt(ctx context.Context, host, addr, path string, roots *x509.CertPool) earlyGet {
	res := earlyGet{Path: path}
	cache := &sessionCache{tls.NewLRUClientSessionCache(1), newTicketProbe()}
	tlsConf := &tls.Config{ServerName: host, RootCAs: roots, MinVersion: tls.VersionTLS13, NextProtos: []string{http3.NextProtoH3}, ClientSessionCache: cache}
	quicConf := &quic.Config{Versions: []quic.Version{quic.Version1}}
	tr := &http3.Transport{}
	defer tr.Close()

	get := func(method string, conn *quic.Conn, path string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(ctx, method, "https://"+host+path, nil)
		req.Header.Set("User-Agent", ua)
		resp, err := tr.NewClientConn(conn).RoundTrip(req)
		if err == nil {
			resp.Body.Close()
		}
		return resp, err
	}

	conn, err := quic.DialAddrEarly(ctx, addr, tlsConf, quicConf)
	if err != nil {
		res.Error = "no HTTP/3 handshake"
		return res
	}
	_, err = get(http.MethodGet, conn, "/")
	select {
	case <-cache.probe.got:
	case <-time.After(ticketWait):
	case <-ctx.Done():
	}
	conn.CloseWithError(0, "")
	if err != nil {
		res.Error = "no HTTP/3 response"
		return res
	}
	if !cache.probe.result().EarlyData {
		res.Error = "no ticket permitting 0-RTT"
		return res
	}

	conn, err = quic.DialAddrEarly(ctx, addr, tlsConf, quicConf)
	if err != nil {
		res.Error = "resumed handshake failed"
		return res
	}
	defer conn.CloseWithError(0, "")
	res.Sent = true
	resp, err := get(http3.MethodGet0RTT, conn, path)
	select {
	case <-conn.HandshakeComplete():
	case <-ctx.Done():
	}
	res.Accepted = conn.ConnectionState().Used0RTT
	switch {
	case errors.Is(err, quic.Err0RTTRejected):
		res.Accepted = false
	case err != nil:
		res.Error = "no response"
	default:
		res.Status = resp.StatusCode
	}
	return res
}

type zeroRTTGetResult struct {
	Domain string   `json:"domain"`
	Query  earlyGet `json:"query"`
	Plain  earlyGet `json:"plain"`
}

// handleZeroRTT sends a GET with a query string as 0-RTT early data, and the
// same GET without one for comparison, both at once.
func handleZeroRTT(w http.ResponseWriter, r *http.Request) {
	if !preflight(w, r) {
		return
	}
	domain := parseDomain(r)
	release, ok := prepare(w, domain)
	if !ok {
		return
	}
	defer release()
	ctx, cancel := context.WithTimeout(r.Context(), 2*opTimeout+ticketWait+time.Second)
	defer cancel()
	res := zeroRTTGetResult{Domain: domain}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); res.Query = tryEarlyGet(ctx, domain, "/?"+earlyQuery) }()
	go func() { defer wg.Done(); res.Plain = tryEarlyGet(ctx, domain, "/") }()
	wg.Wait()
	writeJSON(w, http.StatusOK, res)
}

type errResult struct {
	Domain string `json:"domain"`
	Error  string `json:"error"`
}

// preflight sets the CORS and response headers and answers an OPTIONS
// preflight. It returns false when the request is fully answered.
func preflight(w http.ResponseWriter, r *http.Request) bool {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	return true
}

func parseDomain(r *http.Request) string {
	domain := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("domain")))
	domain = strings.TrimPrefix(strings.TrimPrefix(domain, "https://"), "http://")
	if i := strings.IndexAny(domain, "/:"); i >= 0 {
		domain = domain[:i]
	}
	return strings.TrimSuffix(domain, ".")
}

// prepare validates the domain, applies the SSRF guard and takes a slot of
// the concurrency cap. On failure it answers the request and returns false;
// on success the caller must call release.
func prepare(w http.ResponseWriter, domain string) (release func(), ok bool) {
	if !hostRe.MatchString(domain) {
		writeJSON(w, http.StatusBadRequest, errResult{domain, "invalid domain"})
		return nil, false
	}
	if err := publicResolvable(domain); err != nil {
		writeJSON(w, http.StatusBadRequest, errResult{domain, err.Error()})
		return nil, false
	}
	select {
	case sem <- struct{}{}:
		return func() { <-sem }, true
	case <-time.After(2 * time.Second):
		writeJSON(w, http.StatusServiceUnavailable, errResult{domain, "busy, try again"})
		return nil, false
	}
}

type altSvcResult struct {
	Domain       string `json:"domain"`
	AltSvc       string `json:"alt_svc,omitempty"`
	AdvertisesH3 bool   `json:"advertises_h3"`
}

func handleAltSvc(w http.ResponseWriter, r *http.Request) {
	if !preflight(w, r) {
		return
	}
	domain := parseDomain(r)
	release, ok := prepare(w, domain)
	if !ok {
		return
	}
	defer release()
	// HEAD, then GET if HEAD fails
	ctx, cancel := context.WithTimeout(r.Context(), 2*opTimeout+time.Second)
	defer cancel()
	res := altSvcResult{Domain: domain}
	res.AltSvc, res.AdvertisesH3 = checkAltSvc(ctx, domain)
	writeJSON(w, http.StatusOK, res)
}

type h3Result struct {
	Domain          string         `json:"domain"`
	Version         string         `json:"version"`
	H3HandshakeOK   bool           `json:"h3_handshake_ok"`
	TransportParams map[string]any `json:"transport_params,omitempty"`
	ZeroRTT         *zeroRTT       `json:"zero_rtt,omitempty"`
}

var quicVersions = map[string]quic.Version{"1": quic.Version1, "2": quic.Version2}

func handleH3(w http.ResponseWriter, r *http.Request) {
	if !preflight(w, r) {
		return
	}
	domain := parseDomain(r)
	v, known := quicVersions[r.URL.Query().Get("v")]
	if !known {
		writeJSON(w, http.StatusBadRequest, errResult{domain, "unknown QUIC version, use v=1 or v=2"})
		return
	}
	release, ok := prepare(w, domain)
	if !ok {
		return
	}
	defer release()
	// HEAD, then GET if HEAD fails, then the wait for the session ticket
	ctx, cancel := context.WithTimeout(r.Context(), 2*opTimeout+ticketWait+time.Second)
	defer cancel()
	res := h3Result{Domain: domain, Version: "v" + r.URL.Query().Get("v")}
	res.H3HandshakeOK, res.TransportParams, res.ZeroRTT = tryH3(ctx, domain, v)
	if !res.H3HandshakeOK {
		res.TransportParams, res.ZeroRTT = nil, nil
	}
	writeJSON(w, http.StatusOK, res)
}

// handleCheck runs every check and answers once, for pages that predate the
// per-check endpoints.
func handleCheck(w http.ResponseWriter, r *http.Request) {
	if !preflight(w, r) {
		return
	}
	domain := parseDomain(r)
	release, ok := prepare(w, domain)
	if !ok {
		return
	}
	defer release()

	// altSvc and the two h3 probes (v1, v2) run in parallel, each bounded by opTimeout
	ctx, cancel := context.WithTimeout(r.Context(), opTimeout*3+2*time.Second)
	defer cancel()

	// The Alt-Svc fetch and the two HTTP/3 probes are independent: run them at
	// once, so a check takes as long as the slowest one, not the sum.
	res := result{Domain: domain}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		res.AltSvc, res.AdvertisesH3 = checkAltSvc(ctx, domain)
	}()
	res.H3HandshakeOK, res.QuicVersions, res.TransportParams, res.ZeroRTT = checkH3(ctx, domain)
	wg.Wait()
	writeJSON(w, http.StatusOK, res)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func newMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/check", handleCheck)
	mux.HandleFunc("/check/altsvc", handleAltSvc)
	mux.HandleFunc("/check/h3", handleH3)
	mux.HandleFunc("/check/0rtt", handleZeroRTT)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "savearoundtrip check service. GET /check/altsvc?domain=example.com, /check/h3?v=1&domain=example.com, /check/0rtt?domain=example.com, or /check?domain=example.com for all at once")
	})
	return mux
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Println("listening on :" + port)
	srv := &http.Server{Addr: ":" + port, Handler: newMux(), ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
