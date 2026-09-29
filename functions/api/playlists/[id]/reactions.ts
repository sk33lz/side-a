interface Env { DB: D1Database }

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function validId(value: unknown, max = 100): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= max && /^[a-zA-Z0-9_-]+$/.test(value);
}

async function ensureSchema(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS playlist_reactions (
    playlist_id TEXT NOT NULL, song_id TEXT NOT NULL, voter_id TEXT NOT NULL,
    reaction INTEGER NOT NULL CHECK (reaction IN (-1, 1)), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (playlist_id, song_id, voter_id),
    FOREIGN KEY (playlist_id) REFERENCES shared_playlists(id) ON DELETE CASCADE
  )`).run();
}

export const onRequestGet: PagesFunction<Env> = async ({ request, params, env }) => {
  await ensureSchema(env);
  const voterId = new URL(request.url).searchParams.get('voter') ?? '';
  const result = await env.DB.prepare(`SELECT pr.song_id,
    SUM(CASE WHEN pr.reaction = 1 THEN 1 ELSE 0 END) AS likes,
    SUM(CASE WHEN pr.reaction = -1 THEN 1 ELSE 0 END) AS dislikes,
    MAX(CASE WHEN pr.voter_id = ? THEN pr.reaction ELSE 0 END) AS mine,
    (SELECT latest.reaction FROM playlist_reactions latest
      WHERE latest.playlist_id = pr.playlist_id AND latest.song_id = pr.song_id
      ORDER BY latest.updated_at DESC, latest.rowid DESC LIMIT 1) AS latest
    FROM playlist_reactions pr WHERE pr.playlist_id = ? GROUP BY pr.song_id`)
    .bind(voterId, params.id).all<{ song_id: string; likes: number; dislikes: number; mine: number; latest: number }>();
  return json({ reactions: result.results ?? [] });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, params, env }) => {
  await ensureSchema(env);
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request.' }, 400); }
  const value = body as { songId?: unknown; voterId?: unknown; reaction?: unknown };
  if (!validId(value.songId) || !validId(value.voterId, 120) || ![-1, 0, 1].includes(Number(value.reaction))) {
    return json({ error: 'Invalid reaction.' }, 400);
  }
  const row = await env.DB.prepare('SELECT playlist_json FROM shared_playlists WHERE id = ?')
    .bind(params.id).first<{ playlist_json: string }>();
  if (!row) return json({ error: 'Shared playlist not found.' }, 404);
  try {
    const playlist = JSON.parse(row.playlist_json) as { songs?: Array<{ id?: string }> };
    if (!playlist.songs?.some(song => song.id === value.songId)) return json({ error: 'Track not found.' }, 404);
  } catch { return json({ error: 'Shared playlist data is unavailable.' }, 500); }

  if (Number(value.reaction) === 0) {
    await env.DB.prepare('DELETE FROM playlist_reactions WHERE playlist_id = ? AND song_id = ? AND voter_id = ?')
      .bind(params.id, value.songId, value.voterId).run();
  } else {
    await env.DB.prepare(`INSERT INTO playlist_reactions (playlist_id, song_id, voter_id, reaction, updated_at)
      VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(playlist_id, song_id, voter_id)
      DO UPDATE SET reaction = excluded.reaction, updated_at = datetime('now')`)
      .bind(params.id, value.songId, value.voterId, Number(value.reaction)).run();
  }
  return json({ ok: true });
};
