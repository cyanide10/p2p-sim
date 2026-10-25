package runs

import (
	"encoding/base64"
	"encoding/json"
	"errors"
)

var errBadID = errors.New("malformed run id")

// EncodeID makes the gateway run id: unpadded base64url of the JSON array
// [coordinator, batch_id]. Batch ids are only unique per coordinator, and
// the encoding keeps arbitrary peer ids safe in a URL path.
func EncodeID(coordinator, batchID string) string {
	b, _ := json.Marshal([]string{coordinator, batchID})
	return base64.RawURLEncoding.EncodeToString(b)
}

func DecodeID(id string) (coordinator, batchID string, err error) {
	raw, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return "", "", errBadID
	}
	var parts []string
	if err := json.Unmarshal(raw, &parts); err != nil || len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", errBadID
	}
	return parts[0], parts[1], nil
}
