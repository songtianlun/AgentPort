package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/songtianlun/agentport/server-go/internal/store"
)

type ctxKey int

const userCtxKey ctxKey = 1

type Config struct {
	Version    string
	PublicURL  string
	SigningKey []byte
	StaticFS   fs.FS
}

type Server struct {
	store       *store.Store
	cfg         Config
	mux         *http.ServeMux
	rateMu      sync.Mutex
	unlockTries map[string][]time.Time
}

func NewServer(st *store.Store, cfg Config) *Server {
	if len(cfg.SigningKey) == 0 {
		key := make([]byte, 32)
		_, _ = rand.Read(key)
		cfg.SigningKey = key
	}
	if cfg.Version == "" {
		cfg.Version = "dev"
	}
	s := &Server{
		store:       st,
		cfg:         cfg,
		mux:         http.NewServeMux(),
		unlockTries: map[string][]time.Time{},
	}
	s.registerRoutes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Security & CORS headers
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Referrer-Policy", "same-origin")

	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}

	s.mux.ServeHTTP(w, r)
}

func (s *Server) registerRoutes() {
	// Health & Capabilities
	s.mux.HandleFunc("GET /api/v1/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/v1/capabilities", s.handleCapabilities)

	// Auth & Device Tokens
	s.mux.HandleFunc("POST /api/v1/auth/setup", s.handleAuthSetup)
	s.mux.HandleFunc("POST /api/v1/auth/login", s.handleAuthLogin)
	s.mux.HandleFunc("POST /api/v1/auth/logout", s.handleAuthLogout)
	s.mux.HandleFunc("GET /api/v1/auth/me", s.requireAuth(s.handleAuthMe))
	s.mux.HandleFunc("GET /api/v1/tokens", s.requireAuth(s.handleListTokens))
	s.mux.HandleFunc("POST /api/v1/tokens", s.requireAuth(s.handleCreateToken))
	s.mux.HandleFunc("DELETE /api/v1/tokens/{id}", s.requireAuth(s.handleRevokeToken))

	// Cloud Sync & Session Library
	s.mux.HandleFunc("POST /api/v1/sync/diff", s.requireAuth(s.handleSyncDiff))
	s.mux.HandleFunc("POST /api/v1/sync/sessions", s.requireAuth(s.handleSyncUpsertSession))
	s.mux.HandleFunc("GET /api/v1/sessions", s.requireAuth(s.handleListSessions))
	s.mux.HandleFunc("GET /api/v1/sessions/{id}", s.requireAuth(s.handleGetSession))
	s.mux.HandleFunc("DELETE /api/v1/sessions/{id}", s.requireAuth(s.handleDeleteSession))

	// Content-addressed Blobs
	s.mux.HandleFunc("HEAD /api/v1/blobs/{sha256}", s.requireAuth(s.handleHeadBlob))
	s.mux.HandleFunc("PUT /api/v1/blobs/{sha256}", s.requireAuth(s.handlePutBlob))
	s.mux.HandleFunc("GET /api/v1/blobs/{sha256}", s.requireAuth(s.handleGetBlob))

	// Authenticated Share Management
	s.mux.HandleFunc("GET /api/v1/shares", s.requireAuth(s.handleListShares))
	s.mux.HandleFunc("POST /api/v1/shares", s.requireAuth(s.handleCreateShare))
	s.mux.HandleFunc("DELETE /api/v1/shares/{slug}", s.requireAuth(s.handleRevokeShare))

	// Public Share Viewing (unauthenticated)
	s.mux.HandleFunc("GET /api/v1/public/shares/{slug}", s.handlePublicGetShare)
	s.mux.HandleFunc("POST /api/v1/public/shares/{slug}/unlock", s.handlePublicUnlockShare)
	s.mux.HandleFunc("GET /api/v1/public/shares/{slug}/blobs/{sha256}", s.handlePublicGetShareBlob)

	// Embedded Frontend SPA fallback
	s.mux.HandleFunc("/", s.handleSPA)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "agentport-server",
		"version": s.cfg.Version,
	})
}

func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "API endpoint not found")
		return
	}
	if s.cfg.StaticFS == nil {
		writeError(w, http.StatusNotFound, "Frontend assets not embedded")
		return
	}

	cleaned := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if cleaned == "" || cleaned == "." {
		cleaned = "index.html"
	}

	if f, err := s.cfg.StaticFS.Open(cleaned); err == nil {
		info, statErr := f.Stat()
		_ = f.Close()
		if statErr == nil && !info.IsDir() {
			http.FileServer(http.FS(s.cfg.StaticFS)).ServeHTTP(w, r)
			return
		}
	}

	// SPA history fallback for / and /s/:slug
	data, err := fs.ReadFile(s.cfg.StaticFS, "index.html")
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("AgentPort Server is running. Build frontend assets to enable Web UI."))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) currentUser(r *http.Request) *store.User {
	if authz := strings.TrimSpace(r.Header.Get("Authorization")); strings.HasPrefix(strings.ToLower(authz), "bearer ") {
		tok := strings.TrimSpace(authz[7:])
		if tok != "" {
			if u, err := s.store.GetUserByAPIToken(tok); err == nil {
				return u
			}
		}
	}
	if c, err := r.Cookie("agentport_session"); err == nil && c.Value != "" {
		if u, err := s.store.GetUserByWebSession(c.Value); err == nil {
			return u
		}
	}
	return nil
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := s.currentUser(r)
		if u == nil {
			writeError(w, http.StatusUnauthorized, "未登录或 API Token 无效")
			return
		}
		ctx := context.WithValue(r.Context(), userCtxKey, u)
		next(w, r.WithContext(ctx))
	}
}

func userFromCtx(r *http.Request) *store.User {
	u, _ := r.Context().Value(userCtxKey).(*store.User)
	return u
}

func (s *Server) signShareCookie(slug string) string {
	mac := hmac.New(sha256.New, s.cfg.SigningKey)
	mac.Write([]byte("share-unlock:" + slug))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) isShareUnlockedByCookie(r *http.Request, slug string) bool {
	c, err := r.Cookie("ap_share_" + slug)
	if err != nil || c.Value == "" {
		return false
	}
	expected := s.signShareCookie(slug)
	return hmac.Equal([]byte(c.Value), []byte(expected))
}

func (s *Server) allowUnlockAttempt(r *http.Request, slug string) bool {
	ip := clientIP(r)
	key := ip + ":" + slug
	now := time.Now()
	cutoff := now.Add(-5 * time.Minute)

	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	prev := s.unlockTries[key]
	kept := prev[:0]
	for _, ts := range prev {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= 12 {
		s.unlockTries[key] = kept
		return false
	}
	kept = append(kept, now)
	s.unlockTries[key] = kept
	return true
}

func clientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func (s *Server) buildShareURL(r *http.Request, slug string) string {
	base := strings.TrimRight(strings.TrimSpace(s.cfg.PublicURL), "/")
	if base == "" {
		scheme := "http"
		if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			scheme = "https"
		}
		if r.Host != "" {
			base = scheme + "://" + r.Host
		}
	}
	if base == "" {
		return "/s/" + slug
	}
	return base + "/s/" + slug
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{
		"ok":    false,
		"error": msg,
	})
}

func decodeJSON(r *http.Request, dst any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	return dec.Decode(dst)
}
