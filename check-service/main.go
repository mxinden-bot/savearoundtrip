// savearoundtrip connection checker.
//
// GET /check?domain=example.com  ->  JSON:
//
//	{ "domain", "alt_svc", "advertises_h3", "h3_handshake_ok", "quic_versions", "error" }
//
// - advertises_h3:  fetched the origin over HTTP/2/1.1 and its Alt-Svc header lists h3
// - h3_handshake_ok: completed a real QUIC/HTTP-3 handshake to the origin (proof it speaks h3)
// - quic_versions:  which QUIC versions completed an h3 handshake, e.g. ["v1","v2"]
//
// This is the piece a browser can't do (CORS blocks reading Alt-Svc; browsers
// can't force a cold h3 handshake). Runs on Fly.io where outbound UDP/QUIC works.
package main

import (
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
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

const opTimeout = 6 * time.Second

var hostRe = regexp.MustCompile(`^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$`)

// global concurrency cap so the tiny machine can't be overwhelmed
var sem = make(chan struct{}, 24)

type result struct {
	Domain        string   `json:"domain"`
	AltSvc        string   `json:"alt_svc,omitempty"`
	AdvertisesH3  bool     `json:"advertises_h3"`
	H3HandshakeOK bool     `json:"h3_handshake_ok"`
	QuicVersions  []string `json:"quic_versions,omitempty"`
	Error         string   `json:"error,omitempty"`
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
// Returns whether any completed, and the list of supported versions (v1/v2).
func checkH3(ctx context.Context, host string) (bool, []string) {
	var versions []string
	for _, v := range []struct {
		ver  quic.Version
		name string
	}{
		{quic.Version1, "v1"},
		{quic.Version2, "v2"},
	} {
		if tryH3(ctx, host, v.ver) {
			versions = append(versions, v.name)
		}
	}
	return len(versions) > 0, versions
}

func tryH3(ctx context.Context, host string, v quic.Version) bool {
	tr := &http3.Transport{
		TLSClientConfig: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS13},
		QUICConfig:      &quic.Config{Versions: []quic.Version{v}},
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
			return false
		}
	}
	defer resp.Body.Close()
	return resp.ProtoMajor == 3
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
	res.H3HandshakeOK, res.QuicVersions = checkH3(ctx, domain)
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
