package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/songtianlun/agentport/server-go/internal/store"
)

func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	hasUsers, _ := s.store.HasAnyUser()
	u := s.currentUser(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"mode":          "server",
		"version":       s.cfg.Version,
		"initialized":   hasUsers,
		"authenticated": u != nil,
		"user":          u,
		"publicUrl":     s.cfg.PublicURL,
	})
}

func (s *Server) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	hasUsers, err := s.store.HasAnyUser()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if hasUsers {
		writeError(w, http.StatusConflict, "服务端已完成初始化，请直接登录")
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req, 64*1024); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	u, err := s.store.CreateUser(req.Username, req.Password, "admin")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sessTok, err := s.store.CreateWebSession(u.ID, 14*24*time.Hour)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	setSessionCookie(w, r, sessTok)
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":   true,
		"user": u,
	})
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req, 64*1024); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	u, err := s.store.AuthenticateUser(req.Username, req.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	sessTok, err := s.store.CreateWebSession(u.ID, 14*24*time.Hour)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	setSessionCookie(w, r, sessTok)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"user": u,
	})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("agentport_session"); err == nil && c.Value != "" {
		_ = s.store.DeleteWebSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "agentport_session",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"user":    u,
		"version": s.cfg.Version,
	})
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	tokens, err := s.store.ListAPITokens(u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "items": tokens})
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	var req struct {
		Name       string `json:"name"`
		DeviceName string `json:"deviceName"`
	}
	if err := decodeJSON(r, &req, 32*1024); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	tok, plain, err := s.store.CreateAPIToken(u.ID, req.Name, req.DeviceName)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":    true,
		"token": tok,
		"plain": plain,
	})
}

func (s *Server) handleRevokeToken(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r)
	id := r.PathValue("id")
	if err := s.store.RevokeAPIToken(u.ID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "Token 不存在")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	isHTTPS := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name:     "agentport_session",
		Value:    token,
		Path:     "/",
		MaxAge:   14 * 24 * 3600,
		HttpOnly: true,
		Secure:   isHTTPS,
		SameSite: http.SameSiteLaxMode,
	})
}
