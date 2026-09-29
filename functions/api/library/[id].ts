import { authenticatedUserId, type ClerkEnvironment } from '../../../api/clerkAuth';

interface Env extends ClerkEnvironment { DB: D1Database }

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function validPlaylist(value: unknown, id: string): value is { id: string; name: string; songs: unknown[]; createdAt: string; updatedAt?: string } {
  if (!value || typeof value !== 'object') return false;
  const playlist = value as { id?: unknown; name?: unknown; songs?: unknown; createdAt?: unknown; updatedAt?: unknown };
  return playlist.id === id && typeof playlist.name === 'string' && playlist.name.trim().length > 0 && playlist.name.length <= 200 &&
    Array.isArray(playlist.songs) && playlist.songs.length <= 500 && typeof playlist.createdAt === 'string' &&
    (playlist.updatedAt === undefined || typeof playlist.updatedAt === 'string');
}

function validId(value: string): boolean {
  return value.length >= 8 && value.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(value);
}

export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
  const userId = await authenticatedUserId(request, env);
  if (!userId) return json({ error: 'Sign in is required.' }, 401);
  const id = params.id;
  if (!validId(id)) return json({ error: 'Invalid playlist.' }, 400);
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request.' }, 400); }
  const playlist = (body as { playlist?: unknown })?.playlist;
  if (!validPlaylist(playlist, id)) return json({ error: 'Invalid playlist.' }, 400);
  const playlistJson = JSON.stringify(playlist);
  if (new TextEncoder().encode(playlistJson).length > 256_000) return json({ error: 'Playlist is too large.' }, 413);
  const updatedAt = playlist.updatedAt ?? playlist.createdAt;
  await env.DB.prepare(`INSERT INTO user_playlists
    (user_id, playlist_id, playlist_json, client_updated_at, deleted_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, datetime('now'))
    ON CONFLICT(user_id, playlist_id) DO UPDATE SET
      playlist_json = excluded.playlist_json,
      client_updated_at = excluded.client_updated_at,
      deleted_at = NULL,
      updated_at = datetime('now')
    WHERE excluded.client_updated_at >= user_playlists.client_updated_at
      AND (user_playlists.deleted_at IS NULL OR excluded.client_updated_at > user_playlists.deleted_at)`)
    .bind(userId, id, playlistJson, updatedAt).run();
  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const userId = await authenticatedUserId(request, env);
  if (!userId) return json({ error: 'Sign in is required.' }, 401);
  const id = params.id;
  if (!validId(id)) return json({ error: 'Invalid playlist.' }, 400);
  let deletedAt = new Date().toISOString();
  try {
    const body = await request.json() as { deletedAt?: unknown };
    if (typeof body.deletedAt === 'string') deletedAt = body.deletedAt;
  } catch { /* The server timestamp is a safe fallback. */ }
  await env.DB.prepare(`INSERT INTO user_playlists
    (user_id, playlist_id, playlist_json, client_updated_at, deleted_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, datetime('now'))
    ON CONFLICT(user_id, playlist_id) DO UPDATE SET
      playlist_json = NULL,
      client_updated_at = excluded.client_updated_at,
      deleted_at = excluded.deleted_at,
      updated_at = datetime('now')
    WHERE excluded.deleted_at >= user_playlists.client_updated_at`)
    .bind(userId, id, deletedAt, deletedAt).run();
  return json({ ok: true });
};
