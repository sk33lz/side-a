interface Env { DB: D1Database }

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function validPlaylist(value: unknown): value is { name: string; songs: unknown[]; createdAt?: string } {
  if (!value || typeof value !== 'object') return false;
  const playlist = value as { name?: unknown; songs?: unknown; createdAt?: unknown };
  return typeof playlist.name === 'string' && playlist.name.trim().length > 0 && playlist.name.length <= 200 &&
    Array.isArray(playlist.songs) && playlist.songs.length <= 500 &&
    (playlist.createdAt === undefined || typeof playlist.createdAt === 'string');
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !validPlaylist((body as { playlist?: unknown }).playlist)) {
      return json({ error: 'Invalid playlist.' }, 400);
    }
    const playlist = (body as { playlist: { name: string; songs: unknown[]; createdAt?: string } }).playlist;
    const playlistJson = JSON.stringify(playlist);
    if (new TextEncoder().encode(playlistJson).length > 256_000) return json({ error: 'Playlist is too large.' }, 413);
    const id = base64Url(crypto.getRandomValues(new Uint8Array(18)));
    const editToken = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const editTokenHash = await hashToken(editToken);
    await env.DB.prepare('INSERT INTO shared_playlists (id, playlist_json, edit_token_hash) VALUES (?, ?, ?)')
      .bind(id, playlistJson, editTokenHash).run();
    return json({ id, editToken }, 201);
  } catch {
    return json({ error: 'Could not create the shared playlist.' }, 500);
  }
};
