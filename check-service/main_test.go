package main

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
