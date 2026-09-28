import { PlaylistManager } from '../api/PlaylistManager';
import { LinkIngestionService } from '../api/linkIngestionService';
import type { Playlist, Song } from '../api/models';
import './style.css';

const manager = new PlaylistManager();
const ingestion = new LinkIngestionService();
const createId = (): string => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let currentId: string | null = null;
let sharedPlaylist: Playlist | null = null;
const SHARE_KEYS = 'side-a.share-keys.v1';
let shareSyncQueue: Promise<void> = Promise.resolve();
let notice = '';
let noticeKind: 'success' | 'error' = 'success';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function readSharedPlaylist(): Promise<Playlist | null> {
  const hash = new URLSearchParams(location.hash.slice(1));
  const shareId = hash.get('share');
  if (shareId) {
    try {
      const response = await fetch(`/api/playlists/${encodeURIComponent(shareId)}`);
      if (!response.ok) return null;
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') return null;
      const playlist = (result as { playlist?: Partial<Playlist> }).playlist;
      if (!playlist || typeof playlist.name !== 'string' || !Array.isArray(playlist.songs) || !playlist.songs.every(isSong)) return null;
      return { id: 'shared', name: playlist.name, songs: playlist.songs, createdAt: playlist.createdAt ?? new Date().toISOString() };
    } catch { return null; }
  }
  const encoded = hash.get('playlist');
  if (!encoded) return null;
  try {
    const format = encoded.slice(0, 2);
    const token = format === 'z1' || format === 'j1' ? encoded.slice(2) : encoded;
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    let json: string;
    if (format === 'z1') {
      // Accept links made by the first compressed-link build, which prepended a marker byte.
      const compressed = bytes[0] === 1 ? bytes.slice(1) : bytes;
      json = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else if (format === 'j1') {
      json = new TextDecoder().decode(bytes.slice(1));
    } else {
      json = decodeURIComponent(escape(binary));
    }
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const data = parsed as Partial<Playlist>;
    if (typeof data.name !== 'string' || !Array.isArray(data.songs) || !data.songs.every(isSong)) return null;
    return { id: 'shared', name: data.name, songs: data.songs, createdAt: data.createdAt ?? new Date().toISOString() };
  } catch { return null; }
}

function isSong(value: unknown): value is Song {
  if (!value || typeof value !== 'object') return false;
  const song = value as Partial<Song>;
  return typeof song.id === 'string' && typeof song.title === 'string' && typeof song.artist === 'string' &&
    typeof song.url === 'string' && ['YouTube', 'Spotify', 'SoundCloud', 'Apple Music', 'Tidal'].includes(song.source ?? '');
}

function safeArtwork(url?: string): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.href : undefined; }
  catch { return undefined; }
}

function safeEmbed(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const allowed = ['www.youtube-nocookie.com', 'open.spotify.com', 'w.soundcloud.com', 'embed.music.apple.com'];
    return parsed.protocol === 'https:' && allowed.includes(parsed.hostname) ? parsed.href : undefined;
  } catch { return undefined; }
}

function currentPlaylist(): Playlist | undefined {
  return sharedPlaylist ?? (currentId ? manager.getPlaylist(currentId) : undefined);
}

function shareKeys(): Record<string, { id: string; token: string }> {
  try { return JSON.parse(localStorage.getItem(SHARE_KEYS) ?? '{}') as Record<string, { id: string; token: string }>; }
  catch { return {}; }
}

async function syncCurrentShare(): Promise<boolean> {
  if (!currentId) return true;
  const keys = shareKeys()[currentId];
  const playlist = manager.getPlaylist(currentId);
  if (!keys || !playlist) return true;
  let succeeded = true;
  shareSyncQueue = shareSyncQueue.then(async () => {
    const response = await fetch(`/api/playlists/${encodeURIComponent(keys.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.token}` },
      body: JSON.stringify({ playlist: { name: playlist.name, songs: playlist.songs, createdAt: playlist.createdAt } }),
    });
    if (!response.ok) throw new Error('Could not update the shared playlist.');
  }).catch(() => {
    succeeded = false;
    notice = 'Saved on this device, but the shared link could not be updated. Check your connection and try again.';
    noticeKind = 'error'; render();
  });
  await shareSyncQueue;
  return succeeded;
}

function render(): void {
  const playlists = manager.listPlaylists();
  const active = currentPlaylist();
  const readonly = !!sharedPlaylist;
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <div class="app-shell">
      <header class="topbar"><a class="brand" href="#" aria-label="Side A home"><span class="brand-mark">a</span><span>side a<span class="brand-period">.</span></span></a><span class="top-note">A little more together</span><button class="button button-quiet" id="new-playlist">＋ <span>New playlist</span></button></header>
      <main class="layout">
        <aside class="sidebar"><div class="sidebar-heading"><span>Your library</span><span class="count-pill">${playlists.length}</span></div>
          <nav class="playlist-nav" aria-label="Your playlists">${playlists.length ? playlists.map(p => `<button class="playlist-nav-item ${p.id === active?.id ? 'selected' : ''}" data-open="${escapeHtml(p.id)}" title="${escapeHtml(p.name)}"><span class="playlist-dot"></span><span class="nav-name">${escapeHtml(p.name)}</span><span class="nav-count">${p.songs.length}</span></button>`).join('') : '<p class="sidebar-empty">Your playlists will live here.</p>'}</nav>
          <div class="sidebar-bottom"><div class="avatar">s</div><div><strong>Just you</strong><span>Saved on this device</span></div></div>
        </aside>
        <section class="content">
          ${notice ? `<div class="toast ${noticeKind === 'error' ? 'toast-error' : ''}" role="status">${escapeHtml(notice)}<button id="dismiss-notice" aria-label="Dismiss">×</button></div>` : ''}
          ${sharedPlaylist ? `<div class="shared-banner"><span class="shared-icon">↗</span><div><strong>Someone shared a playlist with you</strong><span>Save your own copy to add or change tracks.</span></div><button class="button button-dark" id="save-shared">Save a copy</button><button class="icon-button banner-close" id="close-shared" aria-label="Close shared playlist">×</button></div>` : ''}
          ${active ? playlistView(active, readonly) : welcomeView()}
        </section>
      </main>
      <footer class="footer"><span>Music links, all in one place.</span><span>Made for sharing <span class="heart">♥</span></span></footer>
      <dialog id="create-dialog" class="dialog"><form id="create-form"><button type="button" class="icon-button dialog-close" data-close aria-label="Close">×</button><span class="eyebrow">START A COLLECTION</span><h2>A new playlist.</h2><p>Give your collection a name. You can share it whenever you like.</p><label for="playlist-name">Playlist name</label><input id="playlist-name" name="name" maxlength="60" placeholder="Sunday morning, road trip…" required autofocus><div class="dialog-actions"><button type="button" class="button button-quiet" data-close>Cancel</button><button class="button button-dark" type="submit">Create playlist <span>→</span></button></div></form></dialog>
      <dialog id="add-dialog" class="dialog"><form id="add-form"><button type="button" class="icon-button dialog-close" data-close aria-label="Close">×</button><span class="eyebrow">ADD TO YOUR PLAYLIST</span><h2>Bring a track along.</h2><p>Paste one link or a whole list, with one URL on each line.</p><label for="song-urls">Track links</label><textarea id="song-urls" name="urls" rows="6" placeholder="https://open.spotify.com/track/…&#10;https://youtu.be/…" required></textarea><span class="field-hint">YouTube · Spotify · SoundCloud · Apple Music · Tidal</span><div class="dialog-actions"><button type="button" class="button button-quiet" data-close>Cancel</button><button class="button button-dark" type="submit">Add tracks <span>→</span></button></div></form></dialog>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>`;
  bindEvents();
}

function welcomeView(): string {
  return `<div class="welcome"><div class="welcome-copy"><span class="eyebrow">YOUR MUSIC, TOGETHER</span><h1>Every song has<br>a <em>place.</em></h1><p>Collect the tracks you love from all over the internet. Make a playlist, pass it along, and make someone's day.</p><div class="welcome-actions"><button class="button button-dark button-large" id="welcome-create">Make a playlist <span>→</span></button><button class="button button-quiet import-trigger" id="import-trigger">Import playlist</button></div><div class="source-row"><span>Works with</span><span class="source-chip">YouTube</span><span class="source-chip">Spotify</span><span class="source-chip">SoundCloud</span><span class="source-chip">Apple Music</span><span class="source-chip">Tidal</span></div></div><div class="art-card"><div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div><div class="art-disc"><div class="disc-label"><span>side a</span><b>♥</b></div></div><div class="art-note note-one"><span>♫</span> good things take time</div><div class="art-note note-two">your mix, your people <span>↗</span></div><span class="art-spark spark-one">✳</span><span class="art-spark spark-two">✳</span><div class="art-caption">PLAY IT YOUR WAY <span>— No. 001</span></div></div><div class="how-strip"><span class="how-item"><b>01</b><span>Collect links from the places you listen</span></span><span class="how-divider"></span><span class="how-item"><b>02</b><span>Add your own titles and notes</span></span><span class="how-divider"></span><span class="how-item"><b>03</b><span>Share a link with someone you love</span></span></div></div>`;
}

function playlistView(playlist: Playlist, readonly: boolean): string {
  const songs = playlist.songs;
  return `<div class="playlist-page"><div class="playlist-cover"><div class="cover-record"><div class="cover-center">a<span>♥</span></div></div><span class="cover-glint">✳</span><span class="cover-label">A SIDE ORIGINAL</span></div><div class="playlist-heading"><div class="playlist-heading-top"><span class="eyebrow">${readonly ? 'SHARED WITH YOU' : 'YOUR COLLECTION'}</span><div class="heading-actions">${!readonly ? `<button class="button button-outline" id="export-playlist">↓ <span>Export</span></button><button class="button button-outline" id="share-playlist">↗ <span>Share playlist</span></button><button class="icon-button more-button" id="delete-playlist" aria-label="Delete playlist">•••</button>` : ''}</div></div><h1>${escapeHtml(playlist.name)}</h1><p class="playlist-meta"><span class="avatar tiny">${readonly ? '♥' : 's'}</span> ${readonly ? 'Shared by someone' : 'Your collection'} <span class="meta-separator">·</span> ${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}</p><p class="playlist-description">A collection of good things, gathered in one place.</p>${!readonly ? `<div class="playlist-main-actions"><button class="button button-dark" id="add-track">＋ <span>Add a track</span></button><button class="button button-quiet" id="sort-playlist">↕ <span>Sort A–Z</span></button><button class="button button-quiet" id="import-trigger">↑ <span>Import</span></button></div>` : ''}</div><section class="track-section"><div class="track-header"><span class="track-number">#</span><span>TITLE</span><span>SERVICE</span><span>LINK</span><span></span></div>${songs.length ? songs.map((song, index) => trackRow(song, index, readonly, songs.length)).join('') : `<div class="empty-tracks"><div class="empty-vinyl">♫</div><strong>This playlist is waiting for a first track.</strong><span>${readonly ? 'It looks like this one is empty.' : 'Add a link from any of your music apps to get started.'}</span>${!readonly ? '<button class="button button-outline" id="add-first">Add the first track →</button>' : ''}</div>`}</section><div class="playlist-endnote"><span>✳</span> A good playlist is a little piece of you.</div></div>`;
}

function trackRow(song: Song, index: number, readonly: boolean, playlistLength: number): string {
  const artwork = safeArtwork(song.artworkUrl);
  let inferredEmbed: string | undefined;
  try { inferredEmbed = ingestion.getEmbedUrl(new URL(song.url), song.source); } catch { /* Keep unsupported links as ordinary links. */ }
  const embed = safeEmbed(song.embedUrl ?? inferredEmbed);
  return `<div class="track-item"><article class="track-row"><span class="track-number">${String(index + 1).padStart(2, '0')}</span><div class="track-details"><div class="track-icon ${song.source.toLowerCase().replace(/\s/g, '-')}" aria-hidden="true">${artwork ? `<img src="${escapeHtml(artwork)}" alt="" loading="lazy">` : song.source === 'YouTube' ? '▶' : song.source === 'Spotify' ? '◉' : song.source === 'Apple Music' ? '♫' : song.source === 'Tidal' ? '▦' : '☁'}</div><div class="track-text"><textarea class="song-title" data-song="${escapeHtml(song.id)}" data-field="title" aria-label="Track title" rows="1" ${readonly ? 'readonly' : ''}>${escapeHtml(song.title)}</textarea><input class="song-artist" data-song="${escapeHtml(song.id)}" data-field="artist" aria-label="Artist" placeholder="Add artist name" value="${escapeHtml(song.artist)}" ${readonly ? 'readonly' : ''}></div></div><span class="service-name">${escapeHtml(song.source)}</span>${embed ? `<button class="link-button preview-toggle" data-preview="${escapeHtml(song.id)}" aria-expanded="false">▶ <span>Preview</span></button>` : `<a class="link-button" href="${escapeHtml(song.url)}" target="_blank" rel="noreferrer" title="Open track link">↗ <span>Open</span></a>`}${!readonly ? `<div class="track-actions"><button class="icon-button move-track" data-move="${escapeHtml(song.id)}" data-offset="-1" aria-label="Move ${escapeHtml(song.title)} up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-button move-track" data-move="${escapeHtml(song.id)}" data-offset="1" aria-label="Move ${escapeHtml(song.title)} down" ${index === playlistLength - 1 ? 'disabled' : ''}>↓</button><button class="icon-button remove-track" data-remove="${escapeHtml(song.id)}" aria-label="Remove ${escapeHtml(song.title)}">×</button></div>` : '<span></span>'}</article>${embed ? `<div class="track-preview" data-player="${escapeHtml(song.id)}" hidden><iframe src="${escapeHtml(embed)}" title="${escapeHtml(song.source)} player for ${escapeHtml(song.title)}" loading="lazy" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allowfullscreen></iframe></div>` : ''}</div>`;
}

function bindEvents(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.querySelectorAll<HTMLElement>('[data-open]').forEach(el => el.addEventListener('click', () => { currentId = el.dataset.open!; sharedPlaylist = null; notice = ''; render(); }));
  app.querySelector('#new-playlist')?.addEventListener('click', openCreate);
  app.querySelector('#welcome-create')?.addEventListener('click', openCreate);
  app.querySelectorAll('#add-track, #add-first').forEach(el => el.addEventListener('click', () => (document.querySelector<HTMLDialogElement>('#add-dialog')!).showModal()));
  app.querySelector('#sort-playlist')?.addEventListener('click', () => withPlaylist(id => manager.sortPlaylist(id), 'Tracks sorted by artist, then title.'));
  app.querySelectorAll<HTMLElement>('[data-preview]').forEach(button => button.addEventListener('click', () => {
    const player = app.querySelector<HTMLElement>(`[data-player="${CSS.escape(button.dataset.preview!)}"]`);
    if (!player) return;
    const opening = player.hidden;
    player.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    button.querySelector('span')!.textContent = opening ? 'Hide' : 'Preview';
  }));
  app.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button => button.addEventListener('click', () => {
    if (!currentId) return;
    manager.moveSong(currentId, button.dataset.move!, Number(button.dataset.offset) as -1 | 1);
    notice = 'Track order updated.'; void syncCurrentShare(); render();
  }));
  app.querySelector('#share-playlist')?.addEventListener('click', sharePlaylist);
  app.querySelector('#export-playlist')?.addEventListener('click', exportPlaylist);
  app.querySelector('#delete-playlist')?.addEventListener('click', deletePlaylist);
  app.querySelector('#save-shared')?.addEventListener('click', saveShared);
  app.querySelector('#close-shared')?.addEventListener('click', () => { sharedPlaylist = null; history.replaceState(null, '', location.pathname + location.search); render(); });
  app.querySelectorAll('#import-trigger').forEach(el => el.addEventListener('click', () => document.querySelector<HTMLInputElement>('#import-file')!.click()));
  app.querySelector('#dismiss-notice')?.addEventListener('click', () => { notice = ''; render(); });
  app.querySelectorAll<HTMLElement>('[data-close]').forEach(el => el.addEventListener('click', () => el.closest('dialog')?.close()));
  app.querySelector<HTMLFormElement>('#create-form')?.addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
    try { const playlist = manager.createPlaylist(String(data.get('name') ?? '')); currentId = playlist.id; notice = 'Playlist created. Add your first track when you’re ready.'; (document.querySelector<HTMLDialogElement>('#create-dialog')!).close(); render(); }
    catch (error) { showError(error); }
  });
  app.querySelector<HTMLFormElement>('#add-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const playlist = currentPlaylist();
    if (!playlist || sharedPlaylist) return;
    const lines = String(data.get('urls') ?? '').split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) { showError(new Error('Paste at least one music link.')); return; }
    const added: Song[] = [];
    const rejected: string[] = [];
    const results = await Promise.all(lines.map(async line => {
      try { return { line, song: await ingestion.ingestSongFromLink(line) }; }
      catch { return { line, song: null }; }
    }));
    results.forEach(result => result.song ? added.push(result.song) : rejected.push(result.line));
    if (!added.length) { showError(new Error('No supported music links found. Check the URLs and try again.')); return; }
    added.forEach(song => manager.addSong(playlist.id, song));
    void syncCurrentShare();
    notice = rejected.length
      ? `Added ${added.length} ${added.length === 1 ? 'track' : 'tracks'}; skipped ${rejected.length} unsupported ${rejected.length === 1 ? 'link' : 'links'}.`
      : `Added ${added.length} ${added.length === 1 ? 'track' : 'tracks'} with available details filled in.`;
    noticeKind = rejected.length ? 'error' : 'success';
    (document.querySelector<HTMLDialogElement>('#add-dialog')!).close(); render();
  });
  app.querySelectorAll<HTMLTextAreaElement>('.song-title').forEach(textarea => {
    const resize = (): void => { textarea.style.height = 'auto'; textarea.style.height = `${textarea.scrollHeight}px`; };
    resize(); textarea.addEventListener('input', resize);
  });
  app.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-song]').forEach(input => input.addEventListener('change', () => {
    if (!currentId || sharedPlaylist) return;
    const row = input.closest('.track-row'); if (!row) return;
    const title = row.querySelector<HTMLTextAreaElement>('[data-field="title"]')!.value;
    const artist = row.querySelector<HTMLInputElement>('[data-field="artist"]')!.value;
    try { manager.updateSong(currentId, input.dataset.song!, { title, artist }); void syncCurrentShare(); }
    catch (error) { showError(error); }
  }));
  app.querySelectorAll<HTMLElement>('[data-remove]').forEach(el => el.addEventListener('click', () => {
    if (!currentId) return;
    manager.removeSong(currentId, el.dataset.remove!); notice = 'Track removed from your playlist.'; void syncCurrentShare(); render();
  }));
  app.querySelector<HTMLInputElement>('#import-file')?.addEventListener('change', importPlaylist);
}

function openCreate(): void { document.querySelector<HTMLDialogElement>('#create-dialog')!.showModal(); }

function withPlaylist(action: (id: string) => void, message: string): void {
  if (!currentId) return;
  action(currentId); notice = message; void syncCurrentShare(); render();
}

async function sharePlaylist(): Promise<void> {
  const playlist = currentPlaylist();
  if (!playlist || !currentId) return;
  let keys = shareKeys();
  let credentials = keys[currentId];
  try {
    if (!credentials) {
      const response = await fetch('/api/playlists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlist: { name: playlist.name, songs: playlist.songs, createdAt: playlist.createdAt } }),
      });
      const result = await response.json() as { id?: string; editToken?: string; error?: string };
      if (!response.ok || !result.id || !result.editToken) throw new Error(result.error ?? 'Cloud sharing is not available.');
      credentials = { id: result.id, token: result.editToken };
      keys = { ...keys, [currentId]: credentials };
      localStorage.setItem(SHARE_KEYS, JSON.stringify(keys));
    } else {
      if (!await syncCurrentShare()) throw new Error('The live playlist could not be refreshed.');
    }
    const url = `${location.origin}${location.pathname}#share=${encodeURIComponent(credentials.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      notice = 'Live share link copied. Anyone with it can see the latest playlist.';
    } catch {
      history.replaceState(null, '', url);
      notice = `Live link created. Copy it from the address bar: ${url}`;
    }
    noticeKind = 'success';
  } catch {
    notice = 'Could not create a live share link. Run the app with the Cloudflare Pages local server and check the D1 setup.';
    noticeKind = 'error';
  }
  render();
}

function saveShared(): void {
  if (!sharedPlaylist) return;
  const copy = manager.createPlaylist(sharedPlaylist.name);
  sharedPlaylist.songs.forEach(song => manager.addSong(copy.id, { ...song, id: createId() }));
  currentId = copy.id; sharedPlaylist = null; history.replaceState(null, '', location.pathname + location.search); notice = 'Saved your own copy. You can now edit and share it.'; render();
}

function downloadPlaylist(playlist: Playlist): void {
  const blob = new Blob([JSON.stringify({ format: 'side-a-playlist', version: 1, playlist }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${playlist.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'playlist'}.json`;
  anchor.click(); URL.revokeObjectURL(url);
}

function exportPlaylist(): void { const playlist = currentPlaylist(); if (playlist) downloadPlaylist(playlist); }

function deletePlaylist(): void {
  const playlist = currentPlaylist(); if (!playlist || !currentId) return;
  if (!confirm(`Delete “${playlist.name}” and its ${playlist.songs.length} tracks?`)) return;
  manager.deletePlaylist(currentId); currentId = manager.listPlaylists()[0]?.id ?? null; notice = 'Playlist deleted.'; render();
}

async function importPlaylist(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement; const file = input.files?.[0]; input.value = '';
  if (!file) return;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object') throw new Error('This file is not a Side A playlist.');
    const root = parsed as { playlist?: Partial<Playlist>; format?: string };
    const data = (root.format === 'side-a-playlist' ? root.playlist : parsed) as Partial<Playlist>;
    if (typeof data.name !== 'string' || !Array.isArray(data.songs) || !data.songs.every(isSong)) throw new Error('This file does not contain a valid playlist.');
    const playlist = manager.createPlaylist(data.name);
    data.songs.forEach(song => manager.addSong(playlist.id, { ...song, id: createId() }));
    currentId = playlist.id; sharedPlaylist = null; notice = `Imported “${playlist.name}” with ${playlist.songs.length} tracks.`; render();
  } catch (error) { showError(error); }
}

function showError(error: unknown): void {
  notice = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  noticeKind = 'error'; render();
}

void readSharedPlaylist().then(playlist => {
  sharedPlaylist = playlist;
  if (new URLSearchParams(location.hash.slice(1)).has('share') && !playlist) {
    notice = 'This live playlist could not be loaded. Check the link and your connection.';
    noticeKind = 'error';
  }
  render();
});
