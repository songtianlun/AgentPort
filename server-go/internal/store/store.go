package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

var (
	ErrNotFound     = errors.New("not found")
	ErrUnauthorized = errors.New("unauthorized")
)

type Store struct {
	db      *sql.DB
	dataDir string
	blobDir string
}

type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt"`
}

type APIToken struct {
	ID         string  `json:"id"`
	UserID     string  `json:"userId"`
	Name       string  `json:"name"`
	DeviceName string  `json:"deviceName"`
	Prefix     string  `json:"prefix"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	RevokedAt  *string `json:"revokedAt"`
}

type SessionMessage struct {
	ID          string              `json:"id"`
	Role        string              `json:"role"`
	Text        string              `json:"text"`
	CreatedAt   string              `json:"createdAt"`
	Attachments []SessionAttachment `json:"attachments,omitempty"`
}

type SessionAttachment struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	MimeType  string `json:"mimeType,omitempty"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
	BlobSHA   string `json:"blobSha256,omitempty"`
}

type SessionPullRequest struct {
	URL        string `json:"url"`
	Repository string `json:"repository,omitempty"`
	Number     int64  `json:"number,omitempty"`
	State      string `json:"state,omitempty"`
	Title      string `json:"title,omitempty"`
	HeadBranch string `json:"headBranch,omitempty"`
	BaseBranch string `json:"baseBranch,omitempty"`
}

type SyncedSession struct {
	ID              string               `json:"id"`
	UserID          string               `json:"userId"`
	SourceTool      string               `json:"sourceTool"`
	MachineID       string               `json:"machineId"`
	MachineName     string               `json:"machineName"`
	SourceThreadID  string               `json:"sourceThreadId"`
	SourceProjectID string               `json:"sourceProjectId"`
	ProjectTitle    string               `json:"projectTitle"`
	WorkspaceRoot   string               `json:"workspaceRoot"`
	Title           string               `json:"title"`
	Provider        string               `json:"provider"`
	Model           string               `json:"model"`
	Branch          string               `json:"branch"`
	ContentHash     string               `json:"contentHash"`
	MessageCount    int                  `json:"messageCount"`
	TurnItemCount   int                  `json:"turnItemCount"`
	AttachmentCount int                  `json:"attachmentCount"`
	SourceCreatedAt string               `json:"sourceCreatedAt"`
	SourceUpdatedAt string               `json:"sourceUpdatedAt"`
	SyncedAt        string               `json:"syncedAt"`
	Messages        []SessionMessage     `json:"messages,omitempty"`
	HandoffMarkdown string               `json:"handoffMarkdown,omitempty"`
	TranscriptMD    string               `json:"transcriptMarkdown,omitempty"`
	DirtyPatch      string               `json:"dirtyPatch,omitempty"`
	PullRequests    []SessionPullRequest `json:"pullRequests,omitempty"`
}

type SyncDiffItem struct {
	SourceTool     string `json:"sourceTool"`
	MachineID      string `json:"machineId"`
	SourceThreadID string `json:"sourceThreadId"`
	ContentHash    string `json:"contentHash"`
}

type ShareRecord struct {
	Slug              string  `json:"slug"`
	UserID            string  `json:"userId"`
	SessionID         string  `json:"sessionId"`
	Title             string  `json:"title"`
	HasPassword       bool    `json:"hasPassword"`
	ExpiresAt         *string `json:"expiresAt"`
	RedactSecrets     bool    `json:"redactSecrets"`
	HidePaths         bool    `json:"hidePaths"`
	IncludePatch      bool    `json:"includePatch"`
	RedactionCount    int     `json:"redactionCount"`
	ViewCount         int64   `json:"viewCount"`
	CreatedAt         string  `json:"createdAt"`
	RevokedAt         *string `json:"revokedAt"`
	SnapshotJSON      string  `json:"-"`
	PasswordHash      string  `json:"-"`
	AllowedBlobHashes string  `json:"-"`
}

func Open(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	blobDir := filepath.Join(dataDir, "blobs")
	if err := os.MkdirAll(blobDir, 0o755); err != nil {
		return nil, fmt.Errorf("create blob dir: %w", err)
	}

	dbPath := filepath.Join(dataDir, "agentport.sqlite3")
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)

	s := &Store{db: db, dataDir: dataDir, blobDir: blobDir}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	ddl := `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS synced_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_tool TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  machine_name TEXT NOT NULL DEFAULT '',
  source_thread_id TEXT NOT NULL,
  source_project_id TEXT NOT NULL DEFAULT '',
  project_title TEXT NOT NULL DEFAULT '',
  workspace_root TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  turn_item_count INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  source_created_at TEXT NOT NULL DEFAULT '',
  source_updated_at TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  handoff_md TEXT NOT NULL DEFAULT '',
  transcript_md TEXT NOT NULL DEFAULT '',
  dirty_patch TEXT NOT NULL DEFAULT '',
  pull_requests_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(user_id, source_tool, machine_id, source_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_synced_sessions_user_updated
  ON synced_sessions(user_id, source_updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS synced_sessions_fts USING fts5(
  session_id UNINDEXED,
  title,
  project_title,
  transcript_md
);

CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  slug TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  password_hash TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  redact_secrets INTEGER NOT NULL DEFAULT 1,
  hide_paths INTEGER NOT NULL DEFAULT 1,
  include_patch INTEGER NOT NULL DEFAULT 0,
  redaction_count INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  allowed_blobs_json TEXT NOT NULL DEFAULT '[]',
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_shares_user_created ON shares(user_id, created_at DESC);
`
	_, err := s.db.Exec(ddl)
	return err
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func (s *Store) HasAnyUser() (bool, error) {
	var cnt int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&cnt); err != nil {
		return false, err
	}
	return cnt > 0, nil
}

func (s *Store) CreateUser(username, password, role string) (*User, error) {
	username = strings.TrimSpace(username)
	if username == "" || len(password) < 6 {
		return nil, errors.New("用户名不能为空且密码长度至少 6 位")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	u := &User{
		ID:        "usr_" + randomHex(8),
		Username:  username,
		Role:      role,
		CreatedAt: nowISO(),
	}
	_, err = s.db.Exec(
		"INSERT INTO users(id, username, password_hash, role, created_at) VALUES(?,?,?,?,?)",
		u.ID, u.Username, string(hash), u.Role, u.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (s *Store) AuthenticateUser(username, password string) (*User, error) {
	var u User
	var pwHash string
	err := s.db.QueryRow(
		"SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?",
		strings.TrimSpace(username),
	).Scan(&u.ID, &u.Username, &pwHash, &u.Role, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(pwHash), []byte(password)); err != nil {
		return nil, ErrUnauthorized
	}
	return &u, nil
}

func (s *Store) CreateWebSession(userID string, ttl time.Duration) (string, error) {
	rawToken := "aps_" + randomHex(24)
	now := time.Now().UTC()
	_, err := s.db.Exec(
		"INSERT INTO web_sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)",
		sha256Hex(rawToken), userID, now.Format(time.RFC3339), now.Add(ttl).Format(time.RFC3339),
	)
	if err != nil {
		return "", err
	}
	return rawToken, nil
}

func (s *Store) DeleteWebSession(rawToken string) error {
	_, err := s.db.Exec("DELETE FROM web_sessions WHERE token_hash = ?", sha256Hex(rawToken))
	return err
}

func (s *Store) GetUserByWebSession(rawToken string) (*User, error) {
	var u User
	var exp string
	err := s.db.QueryRow(`
		SELECT u.id, u.username, u.role, u.created_at, w.expires_at
		FROM web_sessions w JOIN users u ON u.id = w.user_id
		WHERE w.token_hash = ?`, sha256Hex(rawToken),
	).Scan(&u.ID, &u.Username, &u.Role, &u.CreatedAt, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if t, err := time.Parse(time.RFC3339, exp); err == nil && time.Now().UTC().After(t) {
		_ = s.DeleteWebSession(rawToken)
		return nil, ErrUnauthorized
	}
	return &u, nil
}

func (s *Store) CreateAPIToken(userID, name, deviceName string) (*APIToken, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Desktop Sync Token"
	}
	plain := "ap_" + randomHex(24)
	tok := &APIToken{
		ID:         "tok_" + randomHex(8),
		UserID:     userID,
		Name:       name,
		DeviceName: strings.TrimSpace(deviceName),
		Prefix:     plain[:11],
		CreatedAt:  nowISO(),
	}
	_, err := s.db.Exec(
		"INSERT INTO api_tokens(id, user_id, name, device_name, prefix, token_hash, created_at) VALUES(?,?,?,?,?,?,?)",
		tok.ID, tok.UserID, tok.Name, tok.DeviceName, tok.Prefix, sha256Hex(plain), tok.CreatedAt,
	)
	if err != nil {
		return nil, "", err
	}
	return tok, plain, nil
}

func (s *Store) GetUserByAPIToken(plain string) (*User, error) {
	var u User
	var tokenID string
	err := s.db.QueryRow(`
		SELECT t.id, u.id, u.username, u.role, u.created_at
		FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = ? AND t.revoked_at IS NULL`, sha256Hex(plain),
	).Scan(&tokenID, &u.ID, &u.Username, &u.Role, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	_, _ = s.db.Exec("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", nowISO(), tokenID)
	return &u, nil
}

func (s *Store) ListAPITokens(userID string) ([]APIToken, error) {
	rows, err := s.db.Query(`
		SELECT id, user_id, name, device_name, prefix, created_at, last_used_at, revoked_at
		FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]APIToken, 0)
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.DeviceName, &t.Prefix, &t.CreatedAt, &t.LastUsedAt, &t.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

func (s *Store) RevokeAPIToken(userID, tokenID string) error {
	res, err := s.db.Exec("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?", nowISO(), tokenID, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ComputeSyncDiff returns which incoming sessions are new or modified compared to server state.
func (s *Store) ComputeSyncDiff(userID string, items []SyncDiffItem) (needUpload []string, unchanged []string, err error) {
	needUpload = make([]string, 0)
	unchanged = make([]string, 0)
	for _, it := range items {
		var existingHash string
		qErr := s.db.QueryRow(`
			SELECT content_hash FROM synced_sessions
			WHERE user_id = ? AND source_tool = ? AND machine_id = ? AND source_thread_id = ?`,
			userID, it.SourceTool, it.MachineID, it.SourceThreadID,
		).Scan(&existingHash)
		if errors.Is(qErr, sql.ErrNoRows) || existingHash != it.ContentHash {
			needUpload = append(needUpload, it.SourceThreadID)
		} else if qErr != nil {
			return nil, nil, qErr
		} else {
			unchanged = append(unchanged, it.SourceThreadID)
		}
	}
	return needUpload, unchanged, nil
}

func (s *Store) UpsertSession(userID string, sess *SyncedSession) (*SyncedSession, bool, error) {
	if sess.SourceTool == "" {
		sess.SourceTool = "t3-code"
	}
	if sess.MachineID == "" {
		sess.MachineID = "default"
	}
	if sess.SourceThreadID == "" {
		return nil, false, errors.New("sourceThreadId is required")
	}

	// Deterministic ID per (user, sourceTool, machine, thread)
	var existingID string
	var created bool
	err := s.db.QueryRow(`
		SELECT id FROM synced_sessions
		WHERE user_id = ? AND source_tool = ? AND machine_id = ? AND source_thread_id = ?`,
		userID, sess.SourceTool, sess.MachineID, sess.SourceThreadID,
	).Scan(&existingID)
	if errors.Is(err, sql.ErrNoRows) {
		existingID = "ses_" + sha256Hex(fmt.Sprintf("%s:%s:%s:%s", userID, sess.SourceTool, sess.MachineID, sess.SourceThreadID))[:16]
		created = true
	} else if err != nil {
		return nil, false, err
	}

	sess.ID = existingID
	sess.UserID = userID
	sess.SyncedAt = nowISO()
	if sess.MessageCount == 0 && len(sess.Messages) > 0 {
		sess.MessageCount = len(sess.Messages)
	}

	msgBytes, _ := json.Marshal(sess.Messages)
	prBytes, _ := json.Marshal(sess.PullRequests)

	tx, err := s.db.Begin()
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.Exec(`
		INSERT INTO synced_sessions(
			id, user_id, source_tool, machine_id, machine_name, source_thread_id,
			source_project_id, project_title, workspace_root, title, provider, model, branch,
			content_hash, message_count, turn_item_count, attachment_count,
			source_created_at, source_updated_at, synced_at,
			messages_json, handoff_md, transcript_md, dirty_patch, pull_requests_json
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id, source_tool, machine_id, source_thread_id) DO UPDATE SET
			machine_name=excluded.machine_name,
			source_project_id=excluded.source_project_id,
			project_title=excluded.project_title,
			workspace_root=excluded.workspace_root,
			title=excluded.title,
			provider=excluded.provider,
			model=excluded.model,
			branch=excluded.branch,
			content_hash=excluded.content_hash,
			message_count=excluded.message_count,
			turn_item_count=excluded.turn_item_count,
			attachment_count=excluded.attachment_count,
			source_created_at=excluded.source_created_at,
			source_updated_at=excluded.source_updated_at,
			synced_at=excluded.synced_at,
			messages_json=excluded.messages_json,
			handoff_md=excluded.handoff_md,
			transcript_md=excluded.transcript_md,
			dirty_patch=excluded.dirty_patch,
			pull_requests_json=excluded.pull_requests_json
	`,
		sess.ID, userID, sess.SourceTool, sess.MachineID, sess.MachineName, sess.SourceThreadID,
		sess.SourceProjectID, sess.ProjectTitle, sess.WorkspaceRoot, sess.Title, sess.Provider, sess.Model, sess.Branch,
		sess.ContentHash, sess.MessageCount, sess.TurnItemCount, sess.AttachmentCount,
		sess.SourceCreatedAt, sess.SourceUpdatedAt, sess.SyncedAt,
		string(msgBytes), sess.HandoffMarkdown, sess.TranscriptMD, sess.DirtyPatch, string(prBytes),
	)
	if err != nil {
		return nil, false, err
	}

	_, _ = tx.Exec("DELETE FROM synced_sessions_fts WHERE session_id = ?", sess.ID)
	_, err = tx.Exec(
		"INSERT INTO synced_sessions_fts(session_id, title, project_title, transcript_md) VALUES(?,?,?,?)",
		sess.ID, sess.Title, sess.ProjectTitle, sess.TranscriptMD,
	)
	if err != nil {
		return nil, false, err
	}

	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return sess, created, nil
}

func (s *Store) ListSessions(userID, query, sourceTool, projectTitle string, limit int) ([]SyncedSession, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	args := []any{userID}
	var where []string
	where = append(where, "s.user_id = ?")
	if sourceTool != "" {
		where = append(where, "s.source_tool = ?")
		args = append(args, sourceTool)
	}
	if projectTitle != "" {
		where = append(where, "s.project_title = ?")
		args = append(args, projectTitle)
	}

	q := strings.TrimSpace(query)
	var sqlStr string
	if q != "" {
		like := "%" + q + "%"
		where = append(where, "(s.title LIKE ? OR s.project_title LIKE ? OR s.branch LIKE ? OR s.id IN (SELECT session_id FROM synced_sessions_fts WHERE synced_sessions_fts MATCH ?))")
		ftsQ := `"` + strings.ReplaceAll(q, `"`, `""`) + `"`
		args = append(args, like, like, like, ftsQ)
	}

	sqlStr = `
		SELECT s.id, s.user_id, s.source_tool, s.machine_id, s.machine_name, s.source_thread_id,
		       s.source_project_id, s.project_title, s.workspace_root, s.title, s.provider, s.model, s.branch,
		       s.content_hash, s.message_count, s.turn_item_count, s.attachment_count,
		       s.source_created_at, s.source_updated_at, s.synced_at, s.pull_requests_json
		FROM synced_sessions s
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY s.source_updated_at DESC, s.synced_at DESC
		LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]SyncedSession, 0)
	for rows.Next() {
		var item SyncedSession
		var prJSON string
		if err := rows.Scan(
			&item.ID, &item.UserID, &item.SourceTool, &item.MachineID, &item.MachineName, &item.SourceThreadID,
			&item.SourceProjectID, &item.ProjectTitle, &item.WorkspaceRoot, &item.Title, &item.Provider, &item.Model, &item.Branch,
			&item.ContentHash, &item.MessageCount, &item.TurnItemCount, &item.AttachmentCount,
			&item.SourceCreatedAt, &item.SourceUpdatedAt, &item.SyncedAt, &prJSON,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(prJSON), &item.PullRequests)
		out = append(out, item)
	}
	return out, nil
}

func (s *Store) GetSession(userID, sessionID string) (*SyncedSession, error) {
	var item SyncedSession
	var msgJSON, prJSON string
	err := s.db.QueryRow(`
		SELECT id, user_id, source_tool, machine_id, machine_name, source_thread_id,
		       source_project_id, project_title, workspace_root, title, provider, model, branch,
		       content_hash, message_count, turn_item_count, attachment_count,
		       source_created_at, source_updated_at, synced_at,
		       messages_json, handoff_md, transcript_md, dirty_patch, pull_requests_json
		FROM synced_sessions WHERE id = ? AND user_id = ?`, sessionID, userID,
	).Scan(
		&item.ID, &item.UserID, &item.SourceTool, &item.MachineID, &item.MachineName, &item.SourceThreadID,
		&item.SourceProjectID, &item.ProjectTitle, &item.WorkspaceRoot, &item.Title, &item.Provider, &item.Model, &item.Branch,
		&item.ContentHash, &item.MessageCount, &item.TurnItemCount, &item.AttachmentCount,
		&item.SourceCreatedAt, &item.SourceUpdatedAt, &item.SyncedAt,
		&msgJSON, &item.HandoffMarkdown, &item.TranscriptMD, &item.DirtyPatch, &prJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(msgJSON), &item.Messages)
	_ = json.Unmarshal([]byte(prJSON), &item.PullRequests)
	return &item, nil
}

func (s *Store) DeleteSession(userID, sessionID string) error {
	res, err := s.db.Exec("DELETE FROM synced_sessions WHERE id = ? AND user_id = ?", sessionID, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	_, _ = s.db.Exec("DELETE FROM synced_sessions_fts WHERE session_id = ?", sessionID)
	return nil
}

func (s *Store) BlobExists(sha string) bool {
	if !isValidSHA256(sha) {
		return false
	}
	_, err := os.Stat(filepath.Join(s.blobDir, sha))
	return err == nil
}

func (s *Store) SaveBlob(userID, mimeType string, data []byte) (string, error) {
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	dst := filepath.Join(s.blobDir, sha)
	if _, err := os.Stat(dst); os.IsNotExist(err) {
		tmp := dst + ".tmp." + randomHex(4)
		if err := os.WriteFile(tmp, data, 0o600); err != nil {
			return "", err
		}
		if err := os.Rename(tmp, dst); err != nil {
			_ = os.Remove(tmp)
			return "", err
		}
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	_, err := s.db.Exec(
		"INSERT OR IGNORE INTO blobs(sha256, user_id, mime_type, size_bytes, created_at) VALUES(?,?,?,?,?)",
		sha, userID, mimeType, len(data), nowISO(),
	)
	return sha, err
}

func (s *Store) ReadBlob(sha string) ([]byte, string, error) {
	if !isValidSHA256(sha) {
		return nil, "", ErrNotFound
	}
	var mimeType string
	err := s.db.QueryRow("SELECT mime_type FROM blobs WHERE sha256 = ?", sha).Scan(&mimeType)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	data, err := os.ReadFile(filepath.Join(s.blobDir, sha))
	if err != nil {
		return nil, "", ErrNotFound
	}
	return data, mimeType, nil
}

func isValidSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func (s *Store) CreateShare(rec *ShareRecord, plainPassword string) error {
	if rec.Slug == "" {
		rec.Slug = randomHex(6)
	}
	rec.CreatedAt = nowISO()
	if plainPassword != "" {
		h, err := bcrypt.GenerateFromPassword([]byte(plainPassword), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		rec.PasswordHash = string(h)
		rec.HasPassword = true
	}
	_, err := s.db.Exec(`
		INSERT INTO shares(
			slug, user_id, session_id, title, password_hash, expires_at,
			redact_secrets, hide_paths, include_patch, redaction_count,
			snapshot_json, allowed_blobs_json, view_count, created_at
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
		rec.Slug, rec.UserID, rec.SessionID, rec.Title, rec.PasswordHash, rec.ExpiresAt,
		boolToInt(rec.RedactSecrets), boolToInt(rec.HidePaths), boolToInt(rec.IncludePatch), rec.RedactionCount,
		rec.SnapshotJSON, rec.AllowedBlobHashes, rec.CreatedAt,
	)
	return err
}

func (s *Store) ListShares(userID string) ([]ShareRecord, error) {
	rows, err := s.db.Query(`
		SELECT slug, user_id, session_id, title, password_hash, expires_at,
		       redact_secrets, hide_paths, include_patch, redaction_count,
		       view_count, created_at, revoked_at
		FROM shares WHERE user_id = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ShareRecord, 0)
	for rows.Next() {
		var r ShareRecord
		var pw string
		var rs, hp, ip int
		if err := rows.Scan(
			&r.Slug, &r.UserID, &r.SessionID, &r.Title, &pw, &r.ExpiresAt,
			&rs, &hp, &ip, &r.RedactionCount,
			&r.ViewCount, &r.CreatedAt, &r.RevokedAt,
		); err != nil {
			return nil, err
		}
		r.HasPassword = pw != ""
		r.RedactSecrets = rs != 0
		r.HidePaths = hp != 0
		r.IncludePatch = ip != 0
		out = append(out, r)
	}
	return out, nil
}

func (s *Store) GetShareBySlug(slug string) (*ShareRecord, error) {
	var r ShareRecord
	var rs, hp, ip int
	err := s.db.QueryRow(`
		SELECT slug, user_id, session_id, title, password_hash, expires_at,
		       redact_secrets, hide_paths, include_patch, redaction_count,
		       snapshot_json, allowed_blobs_json, view_count, created_at, revoked_at
		FROM shares WHERE slug = ?`, slug,
	).Scan(
		&r.Slug, &r.UserID, &r.SessionID, &r.Title, &r.PasswordHash, &r.ExpiresAt,
		&rs, &hp, &ip, &r.RedactionCount,
		&r.SnapshotJSON, &r.AllowedBlobHashes, &r.ViewCount, &r.CreatedAt, &r.RevokedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.HasPassword = r.PasswordHash != ""
	r.RedactSecrets = rs != 0
	r.HidePaths = hp != 0
	r.IncludePatch = ip != 0
	return &r, nil
}

func (s *Store) VerifySharePassword(rec *ShareRecord, password string) bool {
	if rec.PasswordHash == "" {
		return true
	}
	return bcrypt.CompareHashAndPassword([]byte(rec.PasswordHash), []byte(password)) == nil
}

func (s *Store) IncrementShareViews(slug string) {
	_, _ = s.db.Exec("UPDATE shares SET view_count = view_count + 1 WHERE slug = ?", slug)
}

func (s *Store) RevokeShare(userID, slug string) error {
	res, err := s.db.Exec("UPDATE shares SET revoked_at = ? WHERE slug = ? AND user_id = ?", nowISO(), slug, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
