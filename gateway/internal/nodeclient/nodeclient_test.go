package nodeclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func kind(t *testing.T, err error) *Error {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("got %v (%T); want *Error", err, err)
	}
	return e
}

func TestTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(time.Second):
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	_, err := New(50*time.Millisecond).Health(context.Background(), srv.URL)
	if e := kind(t, err); e.Kind != KindTimeout {
		t.Fatalf("kind %v; want timeout", e.Kind)
	}
}

func TestRefusesRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("redirect was followed")
	}))
	defer target.Close()
	srv := httptest.NewServer(http.RedirectHandler(target.URL+"/health", http.StatusFound))
	defer srv.Close()
	_, err := New(time.Second).Health(context.Background(), srv.URL)
	if e := kind(t, err); e.Kind != KindUnreachable || !strings.Contains(e.Error(), "redirect") {
		t.Fatalf("got %v; want refused redirect", err)
	}
}

func TestOversizedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"pad":"` + strings.Repeat("x", MaxBody) + `"}`))
	}))
	defer srv.Close()
	_, err := New(5*time.Second).Status(context.Background(), srv.URL, "b")
	if e := kind(t, err); e.Kind != KindDecode {
		t.Fatalf("kind %v; want decode", e.Kind)
	}
}

func TestNon2xxCarriesNodeMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"busy","batch_id":"b1"}`))
	}))
	defer srv.Close()
	_, err := New(time.Second).Run(context.Background(), srv.URL, RunRequest{})
	e := kind(t, err)
	if e.Kind != KindStatus || e.Status != 409 || e.Message != "busy" || !strings.Contains(string(e.Body), "b1") {
		t.Fatalf("got %+v; want 409 with the node's body", e)
	}
	if !IsStatus(err, 409) {
		t.Fatal("IsStatus(409) = false")
	}
}

func TestUnreachableAndBadJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not json"))
	}))
	url := srv.URL
	_, err := New(time.Second).Report(context.Background(), url, "b")
	if e := kind(t, err); e.Kind != KindDecode {
		t.Fatalf("kind %v; want decode", e.Kind)
	}
	srv.Close()
	_, err = New(time.Second).Health(context.Background(), url)
	if e := kind(t, err); e.Kind != KindUnreachable {
		t.Fatalf("kind %v; want unreachable", e.Kind)
	}
}
