interface Env { DB: D1Database }

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(value);
}

async function ensureSchema(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS playlist_plays (
    playlist_id TEXT NOT NULL, song_id TEXT NOT NULL, play_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (playlist_id, song_id),
    FOREIGN KEY (playlist_id) REFERENCES shared_playlists(id) ON DELETE CASCADE
  )`).run();
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  await ensureSchema(env);
  const result = await env.DB.prepare('SELECT song_id, play_count FROM playlist_plays WHERE playlist_id = ?')
    .bind(params.id).all<{ song_id: string; play_count: number }>();
  return json({ plays: result.results ?? [] });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, params, env }) => {
  await ensureSchema(env);
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request.' }, 400); }
  const songId = (body as { songId?: unknown })?.songId;
  if (!validId(songId)) return json({ error: 'Invalid track.' }, 400);

  const row = await env.DB.prepare('SELECT playlist_json FROM shared_playlists WHERE id = ?')
    .bind(params.id).first<{ playlist_json: string }>();
  if (!row) return json({ error: 'Shared playlist not found.' }, 404);
  try {
    const playlist = JSON.parse(row.playlist_json) as { songs?: Array<{ id?: string }> };
    if (!playlist.songs?.some(song => song.id === songId)) return json({ error: 'Track not found.' }, 404);
  } catch { return json({ error: 'Shared playlist data is unavailable.' }, 500); }

  await env.DB.prepare(`INSERT INTO playlist_plays (playlist_id, song_id, play_count, updated_at)
    VALUES (?, ?, 1, datetime('now')) ON CONFLICT(playlist_id, song_id)
    DO UPDATE SET play_count = play_count + 1, updated_at = datetime('now')`)
    .bind(params.id, songId).run();
  return json({ ok: true });
};
