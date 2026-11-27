package store

import (
	"testing"
)

func TestStoreSyncAndShareLifecycle(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	u, err := st.CreateUser("admin", "secret123", "admin")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}

	_, plainTok, err := st.CreateAPIToken(u.ID, "Arch Desktop", "archlinux")
	if err != nil {
		t.Fatalf("create token: %v", err)
	}
	authed, err := st.GetUserByAPIToken(plainTok)
	if err != nil || authed.ID != u.ID {
		t.Fatalf("auth token failed: %v", err)
	}

	sess := &SyncedSession{
		SourceTool:      "t3-code",
		MachineID:       "m1",
		MachineName:     "arch",
		SourceThreadID:  "th-1",
		ProjectTitle:    "diarum",
		Title:           "Add holiday support",
		Provider:        "antigravity",
		Model:           "gemini-4-neon",
		ContentHash:     "hash-v1",
		SourceUpdatedAt: "2026-11-27T00:00:00Z",
		Messages: []SessionMessage{
			{ID: "m1", Role: "user", Text: "Add China holidays", CreatedAt: "2026-11-27T00:00:00Z"},
		},
		TranscriptMD: "Add China holidays to diarum",
	}

	saved, created, err := st.UpsertSession(u.ID, sess)
	if err != nil || !created {
		t.Fatalf("upsert failed: %v created=%v", err, created)
	}

	need, unchanged, err := st.ComputeSyncDiff(u.ID, []SyncDiffItem{
		{SourceTool: "t3-code", MachineID: "m1", SourceThreadID: "th-1", ContentHash: "hash-v1"},
		{SourceTool: "t3-code", MachineID: "m1", SourceThreadID: "th-2", ContentHash: "hash-v2"},
	})
	if err != nil || len(unchanged) != 1 || len(need) != 1 {
		t.Fatalf("unexpected diff: need=%v unchanged=%v err=%v", need, unchanged, err)
	}

	found, err := st.ListSessions(u.ID, "holidays", "", "", 50)
	if err != nil || len(found) != 1 || found[0].ID != saved.ID {
		t.Fatalf("fts search failed: found=%+v err=%v", found, err)
	}

	share := &ShareRecord{
		UserID:            u.ID,
		SessionID:         saved.ID,
		Title:             saved.Title,
		RedactSecrets:     true,
		HidePaths:         true,
		SnapshotJSON:      `{"title":"Add holiday support"}`,
		AllowedBlobHashes: `[]`,
	}
	if err := st.CreateShare(share, "pass123"); err != nil {
		t.Fatalf("create share: %v", err)
	}
	loaded, err := st.GetShareBySlug(share.Slug)
	if err != nil || !loaded.HasPassword || !st.VerifySharePassword(loaded, "pass123") || st.VerifySharePassword(loaded, "wrong") {
		t.Fatalf("share password check failed: %v", err)
	}
}
