package dispatch

import (
	"encoding/json"
	"net/http"
)

func jsonDecode(r *http.Request, v any) error { return json.NewDecoder(r.Body).Decode(v) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
