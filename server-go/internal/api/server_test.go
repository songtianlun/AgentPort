package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/songtianlun/agentport/server-go/internal/store"
)

func TestEndToEndSyncAndPasswordShare(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	srv := NewServer(st, Config{Version: "test"})

	// 1. Setup admin
	w := doReq(srv, "POST", "/api/v1/auth/setup", `{"username":"admin","password":"password123"}`, nil, "")
	if w.Code != http.StatusCreated {
		t.Fatalf("setup failed: %d %s", w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()

	// 2. Create API token
	w = doReq(srv, "POST", "/api/v1/tokens", `{"name":"Arch Desktop","deviceName":"arch"}`, cookies, "")
	if w.Code != http.StatusCreated {
		t.Fatalf("create token failed: %d %s", w.Code, w.Body.String())
	}
	var tokResp struct {
		Plain string `json:"plain"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &tokResp)
	if !strings.HasPrefix(tokResp.Plain, "ap_") {
		t.Fatalf("expected ap_ token, got %q", tokResp.Plain)
	}

	// 3. Upsert session via Bearer token
	payload := `{
		"sourceTool": "t3-code",
		"machineId": "m1",
		"machineName": "arch",
		"sourceThreadId": "th-secret",
		"projectTitle": "demo",
		"workspaceRoot": "/home/alice/demo",
		"title": "Fix key leak",
		"provider": "antigravity",
		"model": "gemini-4-neon",
		"contentHash": "h1",
		"messages": [
			{"id":"1","role":"user","text":"My key is sk-proj-abcdefghijklmnopqrstuvwxyz123456 in /home/alice/demo","createdAt":"2026-11-27T00:00:00Z"}
		],
		"transcriptMarkdown": "sk-proj-abcdefghijklmnopqrstuvwxyz123456"
	}`
	w = doReq(srv, "POST", "/api/v1/sync/sessions", payload, nil, tokResp.Plain)
	if w.Code != http.StatusOK {
		t.Fatalf("upsert failed: %d %s", w.Code, w.Body.String())
	}
	var upResp struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &upResp)

	// 4. Create password-protected share with redaction
	shareBody := `{"sessionId":"` + upResp.SessionID + `","password":"open-sesame","redactSecrets":true,"hidePaths":true}`
	w = doReq(srv, "POST", "/api/v1/shares", shareBody, nil, tokResp.Plain)
	if w.Code != http.StatusCreated {
		t.Fatalf("create share failed: %d %s", w.Code, w.Body.String())
	}
	var shResp struct {
		Share struct {
			Slug           string `json:"slug"`
			RedactionCount int    `json:"redactionCount"`
		} `json:"share"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &shResp)
	if shResp.Share.RedactionCount < 2 {
		t.Fatalf("expected redactions >=2, got %d", shResp.Share.RedactionCount)
	}

	// 5. Public GET returns locked=true
	w = doReq(srv, "GET", "/api/v1/public/shares/"+shResp.Share.Slug, "", nil, "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"locked":true`) {
		t.Fatalf("expected locked share, got %d %s", w.Code, w.Body.String())
	}

	// 6. Wrong password rejected
	w = doReq(srv, "POST", "/api/v1/public/shares/"+shResp.Share.Slug+"/unlock", `{"password":"wrong"}`, nil, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on wrong password, got %d", w.Code)
	}

	// 7. Right password unlocks and verifies secret was redacted
	w = doReq(srv, "POST", "/api/v1/public/shares/"+shResp.Share.Slug+"/unlock", `{"password":"open-sesame"}`, nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("unlock failed: %d %s", w.Code, w.Body.String())
	}
	bodyStr := w.Body.String()
	if strings.Contains(bodyStr, "sk-proj-") || strings.Contains(bodyStr, "/home/alice") {
		t.Fatalf("sensitive data leaked in share snapshot: %s", bodyStr)
	}
}

func doReq(h http.Handler, method, path, body string, cookies []*http.Cookie, bearer string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}
