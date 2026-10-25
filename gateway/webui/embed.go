// Package webui embeds the GUI bundle. The Docker build copies web/dist/*
// here (see README for the native steps); the committed placeholder keeps
// `go build` working when no bundle has been copied in.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// FS returns the bundle rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
