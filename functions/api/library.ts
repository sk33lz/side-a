import { authenticatedUserId, type ClerkEnvironment } from '../../api/clerkAuth';

interface Env extends ClerkEnvironment { DB: D1Database }

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const userId = await authenticatedUserId(request, env);
  if (!userId) return json({ error: 'Sign in is required.' }, 401);
  const result = await env.DB.prepare(`SELECT playlist_id, playlist_json, client_updated_at, deleted_at
    FROM user_playlists WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500`).bind(userId)
    .all<{ playlist_id: string; playlist_json: string | null; client_updated_at: string; deleted_at: string | null }>();
  const items: Array<{ id: string; deletedAt: string } | { id: string; playlist: unknown; updatedAt: string }> = [];
  for (const row of result.results ?? []) {
    if (row.deleted_at) { items.push({ id: row.playlist_id, deletedAt: row.deleted_at }); continue; }
    if (!row.playlist_json) continue;
    try { items.push({ id: row.playlist_id, playlist: JSON.parse(row.playlist_json), updatedAt: row.client_updated_at }); }
    catch { /* Skip a malformed row without hiding the rest of the library. */ }
  }
  return json({ items });
};
