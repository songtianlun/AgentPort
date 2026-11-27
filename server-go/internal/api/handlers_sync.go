package api

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/songtianlun/agentport/server-go/internal/store"
)

const (
	maxSessionBodyBytes = 32 << 20 // 32 MiB per session payload
	maxBlobBodyBytes    = 25 << 20 // 25 MiB per attachment blob
)

func (s *Server) handleSyncDiff(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	var req struct {
		Items []store.SyncDiffItem `json:"items"`
	}
	if err := decodeJSON(r, &req, 4<<20); err != nil {
		writeError(w, http.StatusBadRequest, "无效的增量对比请求")
		return
	}
	need, unchanged, err := s.store.ComputeSyncDiff(u.ID, req.Items)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"needUpload": need,
		"unchanged":  unchanged,
	})
}

func (s *Server) handleSyncUpsertSession(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	var sess store.SyncedSession
	if err := decodeJSON(r, &sess, maxSessionBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "解析会话备份数据失败: "+err.Error())
		return
	}
	saved, created, err := s.store.UpsertSession(u.ID, &sess)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"created":   created,
		"sessionId": saved.ID,
		"syncedAt":  saved.SyncedAt,
	})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	qs := r.URL.Query()
	limit, _ := strconv.Atoi(qs.Get("limit"))
	items, err := s.store.ListSessions(
		u.ID,
		qs.Get("q"),
		qs.Get("sourceTool"),
		qs.Get("project"),
		limit,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"items": items,
	})
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	id := r.PathValue("id")
	item, err := s.store.GetSession(u.ID, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "会话不存在")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"session": item,
	})
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	id := r.PathValue("id")
	if err := s.store.DeleteSession(u.ID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "会话不存在")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleHeadBlob(w http.ResponseWriter, r *http.Request) {
	sha := strings.ToLower(strings.TrimSpace(r.PathValue("sha256")))
	if s.store.BlobExists(sha) {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusNotFound)
}

func (s *Server) handlePutBlob(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	expected := strings.ToLower(strings.TrimSpace(r.PathValue("sha256")))
	r.Body = http.MaxBytesReader(w, r.Body, maxBlobBodyBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "读取附件内容失败")
		return
	}
	mimeType := strings.TrimSpace(r.Header.Get("Content-Type"))
	actual, err := s.store.SaveBlob(u.ID, mimeType, data)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if expected != "" && expected != actual {
		writeError(w, http.StatusBadRequest, "SHA256 校验不匹配")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"sha256":    actual,
		"sizeBytes": len(data),
	})
}

func (s *Server) handleGetBlob(w http.ResponseWriter, r *http.Request) {
	sha := strings.ToLower(strings.TrimSpace(r.PathValue("sha256")))
	data, mimeType, err := s.store.ReadBlob(sha)
	if err != nil {
		writeError(w, http.StatusNotFound, "附件不存在")
		return
	}
	serveSafeBlob(w, data, mimeType)
}

func serveSafeBlob(w http.ResponseWriter, data []byte, mimeType string) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	lower := strings.ToLower(mimeType)
	if strings.HasPrefix(lower, "image/png") ||
		strings.HasPrefix(lower, "image/jpeg") ||
		strings.HasPrefix(lower, "image/webp") ||
		strings.HasPrefix(lower, "image/gif") {
		w.Header().Set("Content-Type", mimeType)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment")
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
