package redact

import (
	"strings"
	"testing"
)

func TestApplySecretsAndPaths(t *testing.T) {
	input := `
Using key sk-proj-abcdefghijklmnopqrstuvwxyz123456
GitHub token: ghp_1234567890abcdefghijklmnop
Path: /home/alice/devel/my-repo/main.go
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig
`
	var rep Report
	out := Apply(input, Options{RedactSecrets: true, HidePaths: true}, &rep)

	if strings.Contains(out, "sk-proj-") {
		t.Fatalf("expected OpenAI key to be redacted, got: %s", out)
	}
	if strings.Contains(out, "ghp_") {
		t.Fatalf("expected GitHub token to be redacted, got: %s", out)
	}
	if strings.Contains(out, "/home/alice") {
		t.Fatalf("expected home path to be hidden, got: %s", out)
	}
	if !strings.Contains(out, "~/devel/my-repo/main.go") {
		t.Fatalf("expected anonymized home path, got: %s", out)
	}
	if rep.TotalReplacements < 4 {
		t.Fatalf("expected >=4 replacements, got %d (%+v)", rep.TotalReplacements, rep.ByCategory)
	}
}
