import { authenticatedUserId, type ClerkEnvironment } from '../../../api/clerkAuth';

interface Env extends ClerkEnvironment { DB: D1Database }

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function validPlaylist(value: unknown): value is { name: string; songs: unknown[]; createdAt?: string } {
  if (!value || typeof value !== 'object') return false;
  const playlist = value as { name?: unknown; songs?: unknown; createdAt?: unknown };
  return typeof playlist.name === 'string' && playlist.name.trim().length > 0 && playlist.name.length <= 200 &&
    Array.isArray(playlist.songs) && playlist.songs.length <= 500 &&
    (playlist.createdAt === undefined || typeof playlist.createdAt === 'string');
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const row = await env.DB.prepare('SELECT playlist_json, updated_at FROM shared_playlists WHERE id = ?')
    .bind(params.id).first<{ playlist_json: string; updated_at: string }>();
  if (!row) return json({ error: 'Shared playlist not found.' }, 404);
  try { return json({ id: params.id, playlist: JSON.parse(row.playlist_json), updatedAt: row.updated_at }); }
  catch { return json({ error: 'Shared playlist data is unavailable.' }, 500); }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, params, env }) => {
  const userId = await authenticatedUserId(request, env);
  if (userId) {
    let ownerToken = '';
    try {
      const body = await request.json() as { ownerToken?: unknown };
      if (typeof body.ownerToken === 'string') ownerToken = body.ownerToken;
    } catch { /* A body is only required while claiming an existing share. */ }
    if (ownerToken.length < 32) return json({ error: 'The private recovery key is required to claim this playlist.' }, 400);
    const tokenHash = await hashToken(ownerToken);
    const result = await env.DB.prepare(`UPDATE shared_playlists SET owner_user_id = ?, updated_at = datetime('now')
      WHERE id = ? AND edit_token_hash = ?`).bind(userId, params.id, tokenHash).run();
    return result.meta.changes ? json({ valid: true, claimed: true }) : json({ error: 'This recovery link is no longer valid.' }, 403);
  }
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (token.length < 32) return json({ error: 'Owner access is required.' }, 401);
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare('SELECT id FROM shared_playlists WHERE id = ? AND edit_token_hash = ?')
    .bind(params.id, tokenHash).first<{ id: string }>();
  return row ? json({ valid: true }) : json({ error: 'This recovery link is no longer valid.' }, 403);
};

export const onRequestPut: PagesFunction<Env> = async ({ request, params, env }) => {
  const userId = await authenticatedUserId(request, env);
  const token = userId ? '' : request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!userId && token.length < 32) return json({ error: 'Edit access is required.' }, 401);
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request.' }, 400); }
  if (!body || typeof body !== 'object' || !validPlaylist((body as { playlist?: unknown }).playlist)) {
    return json({ error: 'Invalid playlist.' }, 400);
  }
  const playlist = (body as { playlist: { name: string; songs: unknown[]; createdAt?: string } }).playlist;
  const playlistJson = JSON.stringify(playlist);
  if (new TextEncoder().encode(playlistJson).length > 256_000) return json({ error: 'Playlist is too large.' }, 413);
  const tokenHash = token ? await hashToken(token) : '';
  const result = userId
    ? await env.DB.prepare(`UPDATE shared_playlists SET playlist_json = ?, updated_at = datetime('now')
      WHERE id = ? AND owner_user_id = ?`).bind(playlistJson, params.id, userId).run()
    : await env.DB.prepare(`UPDATE shared_playlists SET playlist_json = ?, updated_at = datetime('now')
      WHERE id = ? AND edit_token_hash = ?`).bind(playlistJson, params.id, tokenHash).run();
  if (!result.meta.changes) return json({ error: 'Edit access is invalid or the playlist no longer exists.' }, 403);
  return json({ ok: true });
};
