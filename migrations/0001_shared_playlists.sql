CREATE TABLE IF NOT EXISTS shared_playlists (
  id TEXT PRIMARY KEY,
  playlist_json TEXT NOT NULL,
  edit_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS shared_playlists_updated_at_idx ON shared_playlists(updated_at);
