// savearoundtrip connection checker.
//
// GET /check?domain=example.com  ->  JSON:
//
//	{ "domain", "alt_svc", "advertises_h3", "h3_handshake_ok", "quic_versions", "transport_params", "error" }
//
// - advertises_h3:  fetched the origin over HTTP/2/1.1 and its Alt-Svc header lists h3
// - h3_handshake_ok: completed a real QUIC/HTTP-3 handshake to the origin (proof it speaks h3)
// - quic_versions:  which QUIC versions completed an h3 handshake, e.g. ["v1","v2"]
// - transport_params: the server's QUIC transport parameters, by name (RFC 9000 §18)
//
// This is the piece a browser can't do (CORS blocks reading Alt-Svc; browsers
// can't force a cold h3 handshake). Runs on Fly.io where outbound UDP/QUIC works.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
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

// global concurrency cap so the tiny machine can't be overwhelmed
var sem = make(chan struct{}, 24)

type result struct {
	Domain          string         `json:"domain"`
	AltSvc          string         `json:"alt_svc,omitempty"`
	AdvertisesH3    bool           `json:"advertises_h3"`
	H3HandshakeOK   bool           `json:"h3_handshake_ok"`
	QuicVersions    []string       `json:"quic_versions,omitempty"`
	TransportParams map[string]any `json:"transport_params,omitempty"`
	Error           string         `json:"error,omitempty"`
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

func setCORS(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); allowedOrigins[origin] {
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

// Probe HTTP/3 by attempting a handshake pinned to each QUIC version we know.
// Returns whether any completed, the list of supported versions (v1/v2), and
// the server's transport parameters from the first version that handshook.
func checkH3(ctx context.Context, host string) (bool, []string, map[string]any) {
	var versions []string
	var tp map[string]any
	for _, v := range []struct {
		ver  quic.Version
		name string
	}{
		{quic.Version1, "v1"},
		{quic.Version2, "v2"},
	} {
		ok, params := tryH3(ctx, host, v.ver)
		if ok {
			versions = append(versions, v.name)
			if tp == nil {
				tp = params
			}
		}
	}
	return len(versions) > 0, versions, tp
}

func tryH3(ctx context.Context, host string, v quic.Version) (bool, map[string]any) {
	tpc := &tpCapture{}
	tr := &http3.Transport{
		TLSClientConfig: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS13},
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
			return false, nil
		}
	}
	defer resp.Body.Close()
	return resp.ProtoMajor == 3, tpc.get()
}

func handleCheck(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")

	domain := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("domain")))
	domain = strings.TrimPrefix(strings.TrimPrefix(domain, "https://"), "http://")
	if i := strings.IndexAny(domain, "/:"); i >= 0 {
		domain = domain[:i]
	}
	domain = strings.TrimSuffix(domain, ".")

	res := result{Domain: domain}
	if !hostRe.MatchString(domain) {
		res.Error = "invalid domain"
		writeJSON(w, http.StatusBadRequest, res)
		return
	}
	if err := publicResolvable(domain); err != nil {
		res.Error = err.Error()
		writeJSON(w, http.StatusBadRequest, res)
		return
	}

	select {
	case sem <- struct{}{}:
		defer func() { <-sem }()
	case <-time.After(2 * time.Second):
		res.Error = "busy, try again"
		writeJSON(w, http.StatusServiceUnavailable, res)
		return
	}

	// altSvc + two h3 probes (v1, v2), each bounded by opTimeout
	ctx, cancel := context.WithTimeout(r.Context(), opTimeout*3+2*time.Second)
	defer cancel()

	res.AltSvc, res.AdvertisesH3 = checkAltSvc(ctx, domain)
	res.H3HandshakeOK, res.QuicVersions, res.TransportParams = checkH3(ctx, domain)
	writeJSON(w, http.StatusOK, res)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/check", handleCheck)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "savearoundtrip check service. GET /check?domain=example.com")
	})
	log.Println("listening on :" + port)
	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
