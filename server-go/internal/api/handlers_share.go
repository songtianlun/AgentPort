package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/songtianlun/agentport/server-go/internal/redact"
	"github.com/songtianlun/agentport/server-go/internal/store"
)

type ShareSnapshot struct {
	Title           string                     `json:"title"`
	SourceTool      string                     `json:"sourceTool"`
	ProjectTitle    string                     `json:"projectTitle"`
	WorkspaceRoot   string                     `json:"workspaceRoot,omitempty"`
	Provider        string                     `json:"provider"`
	Model           string                     `json:"model"`
	Branch          string                     `json:"branch,omitempty"`
	SourceUpdatedAt string                     `json:"sourceUpdatedAt"`
	Messages        []store.SessionMessage     `json:"messages"`
	HandoffMarkdown string                     `json:"handoffMarkdown,omitempty"`
	DirtyPatch      string                     `json:"dirtyPatch,omitempty"`
	PullRequests    []store.SessionPullRequest `json:"pullRequests,omitempty"`
	RedactionReport redact.Report              `json:"redactionReport"`
}

func (s *Server) handleListShares(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	shares, err := s.store.ListShares(u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	type shareItem struct {
		store.ShareRecord
		ShareURL string `json:"shareUrl"`
	}
	items := make([]shareItem, 0, len(shares))
	for _, sh := range shares {
		items = append(items, shareItem{
			ShareRecord: sh,
			ShareURL:    s.buildShareURL(r, sh.Slug),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "items": items})
}

func (s *Server) handleCreateShare(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	var req struct {
		SessionID      string `json:"sessionId"`
		Title          string `json:"title"`
		Password       string `json:"password"`
		ExpiresInHours int    `json:"expiresInHours"`
		RedactSecrets  *bool  `json:"redactSecrets"`
		HidePaths      *bool  `json:"hidePaths"`
		IncludePatch   bool   `json:"includePatch"`
	}
	if err := decodeJSON(r, &req, 128*1024); err != nil {
		writeError(w, http.StatusBadRequest, "无效的分享创建请求")
		return
	}
	sess, err := s.store.GetSession(u.ID, req.SessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "待分享的云端会话不存在，请先同步该会话")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	redactSecrets := true
	if req.RedactSecrets != nil {
		redactSecrets = *req.RedactSecrets
	}
	hidePaths := true
	if req.HidePaths != nil {
		hidePaths = *req.HidePaths
	}

	opts := redact.Options{RedactSecrets: redactSecrets, HidePaths: hidePaths}
	var report redact.Report

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = sess.Title
	}
	title = redact.Apply(title, opts, &report)

	allowedBlobs := make([]string, 0)
	seenBlobs := map[string]bool{}
	sanitizedMsgs := make([]store.SessionMessage, 0, len(sess.Messages))
	for _, m := range sess.Messages {
		cm := m
		cm.Text = redact.Apply(m.Text, opts, &report)
		for _, a := range m.Attachments {
			if a.BlobSHA != "" && !seenBlobs[a.BlobSHA] {
				seenBlobs[a.BlobSHA] = true
				allowedBlobs = append(allowedBlobs, a.BlobSHA)
			}
		}
		sanitizedMsgs = append(sanitizedMsgs, cm)
	}

	snap := ShareSnapshot{
		Title:           title,
		SourceTool:      sess.SourceTool,
		ProjectTitle:    sess.ProjectTitle,
		WorkspaceRoot:   redact.Apply(sess.WorkspaceRoot, opts, &report),
		Provider:        sess.Provider,
		Model:           sess.Model,
		Branch:          sess.Branch,
		SourceUpdatedAt: sess.SourceUpdatedAt,
		Messages:        sanitizedMsgs,
		HandoffMarkdown: redact.Apply(sess.HandoffMarkdown, opts, &report),
		PullRequests:    sess.PullRequests,
		RedactionReport: report,
	}
	if req.IncludePatch && sess.DirtyPatch != "" {
		snap.DirtyPatch = redact.Apply(sess.DirtyPatch, opts, &report)
		snap.RedactionReport = report
	}

	snapBytes, _ := json.Marshal(snap)
	blobBytes, _ := json.Marshal(allowedBlobs)

	var expiresAt *string
	if req.ExpiresInHours > 0 {
		exp := time.Now().UTC().Add(time.Duration(req.ExpiresInHours) * time.Hour).Format(time.RFC3339)
		expiresAt = &exp
	}

	rec := &store.ShareRecord{
		UserID:            u.ID,
		SessionID:         sess.ID,
		Title:             title,
		ExpiresAt:         expiresAt,
		RedactSecrets:     redactSecrets,
		HidePaths:         hidePaths,
		IncludePatch:      req.IncludePatch,
		RedactionCount:    report.TotalReplacements,
		SnapshotJSON:      string(snapBytes),
		AllowedBlobHashes: string(blobBytes),
	}
	if err := s.store.CreateShare(rec, req.Password); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":       true,
		"share":    rec,
		"shareUrl": s.buildShareURL(r, rec.Slug),
	})
}

func (s *Server) handleRevokeShare(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	slug := r.PathValue("slug")
	if err := s.store.RevokeShare(u.ID, slug); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "分享链接不存在")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func isShareExpired(rec *store.ShareRecord) bool {
	if rec.ExpiresAt == nil || *rec.ExpiresAt == "" {
		return false
	}
	t, err := time.Parse(time.RFC3339, *rec.ExpiresAt)
	if err != nil {
		return false
	}
	return time.Now().UTC().After(t)
}

func (s *Server) handlePublicGetShare(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	rec, err := s.store.GetShareBySlug(slug)
	if err != nil || rec.RevokedAt != nil {
		writeError(w, http.StatusNotFound, "分享链接不存在或已被撤销")
		return
	}
	if isShareExpired(rec) {
		writeError(w, http.StatusGone, "分享链接已过期")
		return
	}

	if rec.HasPassword && !s.isShareUnlockedByCookie(r, slug) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          true,
			"locked":      true,
			"slug":        rec.Slug,
			"title":       rec.Title,
			"hasPassword": true,
			"expiresAt":   rec.ExpiresAt,
			"createdAt":   rec.CreatedAt,
		})
		return
	}

	s.store.IncrementShareViews(slug)
	var snap ShareSnapshot
	_ = json.Unmarshal([]byte(rec.SnapshotJSON), &snap)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"locked":         false,
		"slug":           rec.Slug,
		"hasPassword":    rec.HasPassword,
		"redactSecrets":  rec.RedactSecrets,
		"hidePaths":      rec.HidePaths,
		"redactionCount": rec.RedactionCount,
		"viewCount":      rec.ViewCount + 1,
		"expiresAt":      rec.ExpiresAt,
		"createdAt":      rec.CreatedAt,
		"snapshot":       snap,
	})
}

func (s *Server) handlePublicUnlockShare(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	if !s.allowUnlockAttempt(r, slug) {
		writeError(w, http.StatusTooManyRequests, "尝试次数过多，请 5 分钟后再试")
		return
	}
	rec, err := s.store.GetShareBySlug(slug)
	if err != nil || rec.RevokedAt != nil {
		writeError(w, http.StatusNotFound, "分享链接不存在或已被撤销")
		return
	}
	if isShareExpired(rec) {
		writeError(w, http.StatusGone, "分享链接已过期")
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req, 16*1024); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !s.store.VerifySharePassword(rec, req.Password) {
		writeError(w, http.StatusUnauthorized, "访问密码不正确")
		return
	}

	isHTTPS := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name:     "ap_share_" + slug,
		Value:    s.signShareCookie(slug),
		Path:     "/",
		MaxAge:   24 * 3600,
		HttpOnly: true,
		Secure:   isHTTPS,
		SameSite: http.SameSiteLaxMode,
	})

	s.store.IncrementShareViews(slug)
	var snap ShareSnapshot
	_ = json.Unmarshal([]byte(rec.SnapshotJSON), &snap)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"locked":         false,
		"slug":           rec.Slug,
		"hasPassword":    rec.HasPassword,
		"redactSecrets":  rec.RedactSecrets,
		"hidePaths":      rec.HidePaths,
		"redactionCount": rec.RedactionCount,
		"viewCount":      rec.ViewCount + 1,
		"expiresAt":      rec.ExpiresAt,
		"createdAt":      rec.CreatedAt,
		"snapshot":       snap,
	})
}

func (s *Server) handlePublicGetShareBlob(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	sha := strings.ToLower(strings.TrimSpace(r.PathValue("sha256")))
	rec, err := s.store.GetShareBySlug(slug)
	if err != nil || rec.RevokedAt != nil || isShareExpired(rec) {
		writeError(w, http.StatusNotFound, "分享链接无效")
		return
	}
	if rec.HasPassword && !s.isShareUnlockedByCookie(r, slug) {
		writeError(w, http.StatusUnauthorized, "需要先输入分享密码")
		return
	}

	var allowed []string
	_ = json.Unmarshal([]byte(rec.AllowedBlobHashes), &allowed)
	permitted := false
	for _, a := range allowed {
		if strings.EqualFold(a, sha) {
			permitted = true
			break
		}
	}
	if !permitted {
		writeError(w, http.StatusForbidden, "附件不属于当前分享")
		return
	}

	data, mimeType, err := s.store.ReadBlob(sha)
	if err != nil {
		writeError(w, http.StatusNotFound, "附件不存在")
		return
	}
	serveSafeBlob(w, data, mimeType)
}
