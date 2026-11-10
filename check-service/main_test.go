package main

import (
	"crypto/tls"
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
