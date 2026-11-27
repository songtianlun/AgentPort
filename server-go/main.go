package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/songtianlun/agentport/server-go/internal/api"
	"github.com/songtianlun/agentport/server-go/internal/store"
	"github.com/songtianlun/agentport/server-go/static"
)

var Version = "dev"

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func loadOrCreateSigningKey(dataDir string) []byte {
	keyPath := filepath.Join(dataDir, ".signing-key")
	if raw, err := os.ReadFile(keyPath); err == nil {
		if decoded, err := hex.DecodeString(strings.TrimSpace(string(raw))); err == nil && len(decoded) >= 32 {
			return decoded
		}
	}
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	_ = os.WriteFile(keyPath, []byte(hex.EncodeToString(key)), 0o600)
	return key
}

func main() {
	addr := flag.String("addr", envOr("AGENTPORT_ADDR", ":"+envOr("PORT", "8080")), "HTTP listen address")
	dataDir := flag.String("data-dir", envOr("AGENTPORT_DATA_DIR", envOr("DATA_DIR", "./data")), "Persistent data directory")
	publicURL := flag.String("public-url", envOr("AGENTPORT_PUBLIC_URL", envOr("PUBLIC_URL", "")), "Public base URL for share links")
	flag.Parse()

	st, err := store.Open(*dataDir)
	if err != nil {
		log.Fatalf("failed to open store: %v", err)
	}
	defer st.Close()

	// Optional zero-click admin bootstrap via environment variables
	adminUser := strings.TrimSpace(os.Getenv("AGENTPORT_ADMIN_USER"))
	adminPass := os.Getenv("AGENTPORT_ADMIN_PASS")
	if adminUser != "" && adminPass != "" {
		if hasUsers, err := st.HasAnyUser(); err == nil && !hasUsers {
			if _, err := st.CreateUser(adminUser, adminPass, "admin"); err != nil {
				log.Printf("warn: failed to bootstrap admin user: %v", err)
			} else {
				log.Printf("bootstrapped initial admin user %q from env", adminUser)
			}
		}
	}

	srv := api.NewServer(st, api.Config{
		Version:    Version,
		PublicURL:  *publicURL,
		SigningKey: loadOrCreateSigningKey(*dataDir),
		StaticFS:   static.DistFS(),
	})

	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("AgentPort Server %s listening on %s (dataDir=%s)", Version, *addr, *dataDir)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server exited: %v", err)
	}
}
