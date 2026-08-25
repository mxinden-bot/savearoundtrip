package main

import (
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
