package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/quic-go/qlog"
)

// A remote parameters_set event should be captured and decoded into a name->value
// map matching the RFC 9000 transport-parameter names quic-go's qlog emits.
func TestTPCaptureRemote(t *testing.T) {
	cap := &tpCapture{}
	rec := cap.AddProducer()
	rec.RecordEvent(qlog.ParametersSet{
		Initiator:               qlog.InitiatorRemote,
		MaxIdleTimeout:          30 * time.Second,
		MaxUDPPayloadSize:       1452,
		ActiveConnectionIDLimit: 8,
		InitialMaxData:          15728640,
		InitialMaxStreamsBidi:   100,
		DisableActiveMigration:  true,
	})

	tp := cap.get()
	if tp == nil {
		t.Fatal("expected transport params to be captured, got nil")
	}
	for _, k := range []string{
		"max_idle_timeout", "max_udp_payload_size", "active_connection_id_limit",
		"initial_max_data", "initial_max_streams_bidi", "disable_active_migration",
	} {
		if _, ok := tp[k]; !ok {
			t.Errorf("missing expected transport parameter %q; got %v", k, tp)
		}
	}
	if _, ok := tp["initiator"]; ok {
		t.Error("internal qlog field \"initiator\" should be stripped")
	}
	if v, ok := tp["initial_max_data"].(float64); !ok || v != 15728640 {
		t.Errorf("initial_max_data = %v, want 15728640", tp["initial_max_data"])
	}
}

// Our own (local) params and restored params must be ignored: we only want the
// server's freshly received parameters.
func TestTPCaptureIgnoresLocalAndRestored(t *testing.T) {
	cap := &tpCapture{}
	rec := cap.AddProducer()
	rec.RecordEvent(qlog.ParametersSet{Initiator: qlog.InitiatorLocal, InitialMaxData: 1})
	rec.RecordEvent(qlog.ParametersSet{Initiator: qlog.InitiatorRemote, Restore: true, InitialMaxData: 2})
	if tp := cap.get(); tp != nil {
		t.Errorf("expected nil (local + restored ignored), got %v", tp)
	}
}

// A ticket that permits early data (QUIC max_early_data_size = 0xffffffff, which
// crypto/tls records as SessionState.EarlyData) should surface as both a ticket
// being issued and 0-RTT being offered.
func TestTicketProbeEarlyData(t *testing.T) {
	cs, err := tls.NewResumptionState([]byte("ticket"), &tls.SessionState{EarlyData: true})
	if err != nil {
		t.Fatalf("NewResumptionState: %v", err)
	}
	tkt := newTicketProbe()
	tkt.Put("k", cs)
	r := tkt.result()
	if !r.TicketIssued || !r.EarlyData {
		t.Errorf("want ticket_issued=true early_data=true, got %+v", r)
	}
	select {
	case <-tkt.got:
	default:
		t.Error("expected got channel to be closed after Put")
	}
}

// A resumption ticket without early data means resumption is possible but 0-RTT
// is not offered.
func TestTicketProbeNoEarlyData(t *testing.T) {
	cs, err := tls.NewResumptionState([]byte("ticket"), &tls.SessionState{})
	if err != nil {
		t.Fatalf("NewResumptionState: %v", err)
	}
	tkt := newTicketProbe()
	tkt.Put("k", cs)
	if r := tkt.result(); !r.TicketIssued || r.EarlyData {
		t.Errorf("want ticket_issued=true early_data=false, got %+v", r)
	}
}

// No ticket at all: the server issued none, so neither resumption nor 0-RTT.
func TestTicketProbeNone(t *testing.T) {
	tkt := newTicketProbe()
	tkt.Put("k", nil)
	if r := tkt.result(); r.TicketIssued || r.EarlyData {
		t.Errorf("want ticket_issued=false early_data=false, got %+v", r)
	}
}

func TestOriginAllowed(t *testing.T) {
	for origin, want := range map[string]bool{
		"https://savearoundtrip.com":                                        true,
		"https://www.savearoundtrip.com":                                    true,
		"https://claude-offer-and-race-savearoundtrip.mail-f1c.workers.dev": true,
		"http://claude-offer-and-race-savearoundtrip.mail-f1c.workers.dev":  false,
		"https://evil.example/-savearoundtrip.mail-f1c.workers.dev":         false,
		"https://x-savearoundtrip.mail-f1c.workers.dev.evil.example":        false,
		"https://x-savearoundtrip.mail-f1c.workers.dev:8443":                false,
		"https://savearoundtrip.mail-f1c.workers.dev.evil.example":          false,
		"https://example.com":                                               false,
		"":                                                                  false,
	} {
		if got := originAllowed(origin); got != want {
			t.Errorf("originAllowed(%q) = %v, want %v", origin, got, want)
		}
	}
}

func serve(t *testing.T, method, target, origin string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, req)
	var body map[string]any
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
	}
	return rec, body
}

// The per-check endpoints answer CORS preflights for the site and its previews.
func TestSplitEndpointsPreflight(t *testing.T) {
	for _, path := range []string{"/check/altsvc", "/check/h3", "/check"} {
		origin := "https://claude-offer-and-race-savearoundtrip.mail-f1c.workers.dev"
		rec, _ := serve(t, http.MethodOptions, path+"?domain=example.com", origin)
		if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Errorf("OPTIONS %s: code %d, ACAO %q", path, rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
		}
	}
}

// Invalid input is rejected before any network work, as JSON the page can read.
func TestSplitEndpointsRejectBadInput(t *testing.T) {
	cases := []struct{ target, want string }{
		{"/check/h3?v=3&domain=example.com", "unknown QUIC version"},
		{"/check/h3?domain=example.com", "unknown QUIC version"},
		{"/check/h3?v=1&domain=not_a_domain", "invalid domain"},
		{"/check/altsvc?domain=not_a_domain", "invalid domain"},
		{"/check?domain=not_a_domain", "invalid domain"},
	}
	for _, c := range cases {
		rec, body := serve(t, http.MethodGet, c.target, "https://savearoundtrip.com")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: code %d, want 400", c.target, rec.Code)
		}
		if msg, _ := body["error"].(string); !strings.Contains(msg, c.want) {
			t.Errorf("%s: error %q, want it to contain %q", c.target, msg, c.want)
		}
		if rec.Header().Get("Access-Control-Allow-Origin") != "https://savearoundtrip.com" {
			t.Errorf("%s: missing CORS header on the error response", c.target)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("%s: content type %q", c.target, ct)
		}
	}
}

// testH3Server serves HTTP/3 on localhost with a fresh self-signed certificate.
// Requests with a query string get 425 Too Early, as some servers do in 0-RTT.
func testH3Server(t *testing.T, allow0RTT, rotateKeys bool) (addr string, roots *x509.CertPool) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		DNSNames:     []string{"localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	roots = x509.NewCertPool()
	roots.AddCert(cert)

	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	conf := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	var conns atomic.Int32
	if rotateKeys {
		// each connection gets new ticket keys, so no ticket is ever accepted
		conf.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) {
			c := conf.Clone()
			c.SetSessionTicketKeys([][32]byte{{byte(conns.Add(1))}})
			return c, nil
		}
	}
	srv := &http3.Server{
		TLSConfig:  conf,
		QUICConfig: &quic.Config{Allow0RTT: allow0RTT},
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.RawQuery != "" {
				w.WriteHeader(http.StatusTooEarly)
			}
		}),
	}
	go srv.Serve(udp)
	t.Cleanup(func() { srv.Close(); udp.Close() })
	return udp.LocalAddr().String(), roots
}

func TestEarlyGet(t *testing.T) {
	addr, roots := testH3Server(t, true, false)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for path, status := range map[string]int{"/": http.StatusOK, "/?" + earlyQuery: http.StatusTooEarly} {
		got := earlyGetAt(ctx, "localhost", addr, path, roots)
		if !got.Sent || !got.Accepted || got.Status != status || got.Error != "" {
			t.Errorf("%s: got %+v, want sent and accepted with status %d", path, got, status)
		}
	}
}

func TestEarlyGetWithout0RTT(t *testing.T) {
	addr, roots := testH3Server(t, false, false)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	got := earlyGetAt(ctx, "localhost", addr, "/", roots)
	if got.Sent || got.Accepted || got.Error != "no ticket permitting 0-RTT" {
		t.Errorf("got %+v, want nothing sent for lack of an early-data ticket", got)
	}
}

func TestEarlyGetRejected(t *testing.T) {
	addr, roots := testH3Server(t, true, true)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	got := earlyGetAt(ctx, "localhost", addr, "/", roots)
	if !got.Sent || got.Accepted || got.Error != "" {
		t.Errorf("got %+v, want sent but not accepted", got)
	}
}
