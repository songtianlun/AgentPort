package static

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var rawDistFS embed.FS

// DistFS returns the embedded frontend dist filesystem rooted at dist/.
func DistFS() fs.FS {
	sub, err := fs.Sub(rawDistFS, "dist")
	if err != nil {
		return rawDistFS
	}
	return sub
}
