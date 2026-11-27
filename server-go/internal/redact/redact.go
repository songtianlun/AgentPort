package redact

import (
	"regexp"
	"strings"
)

type rule struct {
	name string
	re   *regexp.Regexp
	repl string
}

var secretRules = []rule{
	{
		name: "pem_private_key",
		re:   regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`),
		repl: "[REDACTED:PRIVATE_KEY]",
	},
	{
		name: "openai_key",
		re:   regexp.MustCompile(`\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b`),
		repl: "[REDACTED:API_KEY]",
	},
	{
		name: "github_token",
		re:   regexp.MustCompile(`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b`),
		repl: "[REDACTED:GITHUB_TOKEN]",
	},
	{
		name: "aws_access_key",
		re:   regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
		repl: "[REDACTED:AWS_KEY]",
	},
	{
		name: "agentport_token",
		re:   regexp.MustCompile(`\bap_[A-Za-z0-9_-]{20,}\b`),
		repl: "[REDACTED:AGENTPORT_TOKEN]",
	},
	{
		name: "bearer_token",
		re:   regexp.MustCompile(`(?i)(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*`),
		repl: "${1}[REDACTED:BEARER_TOKEN]",
	},
	{
		name: "generic_env_secret",
		re:   regexp.MustCompile(`(?i)\b([A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD|PRIVATE_KEY|WEBHOOK_SECRET)\s*[:=]\s*["']?)([^\s"'` + "`" + `]{8,})`),
		repl: "${1}[REDACTED]",
	},
}

var (
	unixHomeRe = regexp.MustCompile(`(?:/home|/Users)/[A-Za-z0-9._-]+`)
	winHomeRe  = regexp.MustCompile(`[A-Za-z]:\\Users\\[A-Za-z0-9._-]+`)
)

// Options controls redaction behavior when creating public share snapshots.
type Options struct {
	RedactSecrets bool
	HidePaths     bool
}

// Report summarizes what was redacted in a text or session snapshot.
type Report struct {
	TotalReplacements int            `json:"totalReplacements"`
	ByCategory        map[string]int `json:"byCategory"`
}

// Apply scrubs secrets and/or home directory paths according to opts.
func Apply(input string, opts Options, report *Report) string {
	if input == "" {
		return input
	}
	if report != nil && report.ByCategory == nil {
		report.ByCategory = map[string]int{}
	}
	out := input

	if opts.RedactSecrets {
		for _, r := range secretRules {
			matches := r.re.FindAllStringIndex(out, -1)
			if len(matches) > 0 {
				out = r.re.ReplaceAllString(out, r.repl)
				if report != nil {
					report.TotalReplacements += len(matches)
					report.ByCategory[r.name] += len(matches)
				}
			}
		}
	}

	if opts.HidePaths {
		if m := unixHomeRe.FindAllStringIndex(out, -1); len(m) > 0 {
			out = unixHomeRe.ReplaceAllString(out, "~")
			if report != nil {
				report.TotalReplacements += len(m)
				report.ByCategory["home_path"] += len(m)
			}
		}
		if m := winHomeRe.FindAllStringIndex(out, -1); len(m) > 0 {
			out = winHomeRe.ReplaceAllString(out, "~")
			if report != nil {
				report.TotalReplacements += len(m)
				report.ByCategory["home_path"] += len(m)
			}
		}
	}

	return strings.TrimRight(out, "\x00")
}
