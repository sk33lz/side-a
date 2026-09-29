ALTER TABLE shared_playlists ADD COLUMN owner_user_id TEXT;

CREATE INDEX IF NOT EXISTS shared_playlists_owner_user_idx
  ON shared_playlists(owner_user_id);

CREATE TABLE IF NOT EXISTS user_playlists (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  playlist_json TEXT,
  client_updated_at TEXT NOT NULL,
  deleted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, playlist_id)
);

CREATE INDEX IF NOT EXISTS user_playlists_user_idx
  ON user_playlists(user_id, updated_at);
