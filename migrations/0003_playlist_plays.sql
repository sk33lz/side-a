CREATE TABLE IF NOT EXISTS playlist_plays (
  playlist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (playlist_id, song_id),
  FOREIGN KEY (playlist_id) REFERENCES shared_playlists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS playlist_plays_playlist_idx
  ON playlist_plays(playlist_id);
