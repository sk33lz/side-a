CREATE TABLE IF NOT EXISTS playlist_reactions (
  playlist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  reaction INTEGER NOT NULL CHECK (reaction IN (-1, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (playlist_id, song_id, voter_id),
  FOREIGN KEY (playlist_id) REFERENCES shared_playlists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS playlist_reactions_playlist_idx
  ON playlist_reactions(playlist_id);
