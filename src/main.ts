import { PLAYLIST_STORAGE_KEY, PlaylistManager } from '../api/PlaylistManager';
import { LinkIngestionService } from '../api/linkIngestionService';
import type { Playlist, PlaylistTheme, Song } from '../api/models';
import './style.css';

type YouTubePlayer = { getDuration(): number; destroy(): void };
type YouTubeApi = { Player: new (element: HTMLIFrameElement, options: { events: { onReady(event: { target: YouTubePlayer }): void } }) => YouTubePlayer };
declare global { interface Window { YT?: YouTubeApi; onYouTubeIframeAPIReady?: () => void } }

const manager = new PlaylistManager();
const ingestion = new LinkIngestionService();
const createId = (): string => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let currentId: string | null = null;
let sharedPlaylist: Playlist | null = null;
const SHARE_KEYS = 'side-a.share-keys.v1';
const SHARED_ORDER_KEY = 'side-a.shared-order.v1';
const VOTER_KEY = 'side-a.voter.v1';
const THEME_KEY = 'side-a.theme.v1';
const themes = ['side-a', 'mixtape', 'cd-mix', 'playlist'] as const;
type Theme = PlaylistTheme;
const themeLabels: Record<Theme, string> = { 'side-a': 'Side A', mixtape: 'Mixtape', 'cd-mix': 'CD Mix', playlist: 'Playlist' };
function savedTheme(): Theme {
  try { const value = localStorage.getItem(THEME_KEY); return themes.includes(value as Theme) ? value as Theme : 'mixtape'; }
  catch { return 'mixtape'; }
}
let currentTheme: Theme = savedTheme();
let shareSyncQueue: Promise<void> = Promise.resolve();
let notice = '';
let noticeKind: 'success' | 'error' = 'success';
let playerOpen = false;
let playerTrackId: string | null = null;
let playerPlaylistId: string | null = null;
let buttonAudio: AudioContext | null = null;
let currentShareId: string | null = null;
let pendingOwnerToken: string | null = null;
let senderOrder: string[] = [];
type ReactionSummary = { likes: number; dislikes: number; mine: -1 | 0 | 1; latest: -1 | 0 | 1 };
let reactions: Record<string, ReactionSummary> = {};
let plays: Record<string, number> = {};
let youtubeApiPromise: Promise<YouTubeApi> | null = null;
let activeYouTubePlayer: YouTubePlayer | null = null;

function isTheme(value: unknown): value is Theme { return typeof value === 'string' && themes.includes(value as Theme); }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function formatLogo(theme: Theme, showLabel = true): string {
  const drawings: Record<Theme, string> = {
    'side-a': '<circle class="logo-body" cx="23" cy="24" r="18"/><circle class="logo-paper" cx="23" cy="24" r="7"/><circle class="logo-body" cx="23" cy="24" r="2"/><path class="logo-heavy" d="M38 7l4 3-8 18-4-2z"/><path class="logo-light" d="M10 18a15 15 0 0 1 20-7M9 27a15 15 0 0 0 18 11"/>',
    mixtape: '<rect class="logo-body" x="4" y="9" width="40" height="30" rx="5"/><rect class="logo-paper" x="9" y="13" width="30" height="13" rx="2"/><circle class="logo-body" cx="16" cy="19.5" r="5"/><circle class="logo-paper" cx="16" cy="19.5" r="2"/><circle class="logo-body" cx="32" cy="19.5" r="5"/><circle class="logo-paper" cx="32" cy="19.5" r="2"/><path class="logo-paper" d="M13 35h22l-3-7H16z"/><circle class="logo-body" cx="18" cy="33" r="1.5"/><circle class="logo-body" cx="30" cy="33" r="1.5"/>',
    'cd-mix': '<circle class="logo-body" cx="24" cy="24" r="19"/><circle class="logo-paper" cx="24" cy="24" r="6"/><circle class="logo-body" cx="24" cy="24" r="2"/><path class="logo-light" d="M27 7l-2 12M41 18l-12 5M36 37l-9-10"/><path class="logo-paper" d="M13 11a17 17 0 0 0-5 8l10 2z"/>',
    playlist: '<rect class="logo-body" x="5" y="5" width="38" height="38" rx="8"/><circle class="logo-paper" cx="17" cy="17" r="7"/><path class="logo-body" d="M15 13l7 4-7 4z"/><path class="logo-light" d="M28 13h8M28 19h8M12 29h24M12 36h18"/>',
  };
  return `<span class="format-logo format-logo-${theme}" role="img" aria-label="${escapeHtml(themeLabels[theme])} logo"><svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">${drawings[theme]}</svg>${showLabel ? `<span>${escapeHtml(themeLabels[theme])}</span>` : ''}</span>`;
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

function parseDuration(value: string): number | undefined {
  const clean = value.trim();
  if (!clean) return undefined;
  if (/^\d+$/.test(clean)) return Number(clean) * 60;
  const match = clean.match(/^(\d+):([0-5]\d)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function playlistDuration(playlist?: Playlist): { seconds: number; complete: boolean } {
  if (!playlist?.songs.length) return { seconds: 0, complete: false };
  const known = playlist.songs.filter(song => typeof song.durationSeconds === 'number' && song.durationSeconds > 0);
  return { seconds: known.reduce((total, song) => total + (song.durationSeconds ?? 0), 0), complete: known.length === playlist.songs.length };
}

function tapeLength(playlist?: Playlist): string {
  const duration = playlistDuration(playlist);
  if (!duration.seconds) return '-- MIN';
  return `${Math.ceil(duration.seconds / 60)}${duration.complete ? '' : '+'} MIN`;
}

function voterId(): string {
  try {
    const saved = localStorage.getItem(VOTER_KEY);
    if (saved) return saved;
    const value = createId(); localStorage.setItem(VOTER_KEY, value); return value;
  } catch { return createId(); }
}

function applySharedOrder(playlist: Playlist, shareId: string): Playlist {
  try {
    const orders = JSON.parse(localStorage.getItem(SHARED_ORDER_KEY) ?? '{}') as Record<string, string[]>;
    const order = orders[shareId];
    if (!Array.isArray(order)) return playlist;
    const positions = new Map(order.map((id, index) => [id, index]));
    playlist.songs.sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  } catch { /* Keep the sender's order if local preferences cannot be read. */ }
  return playlist;
}

function saveSharedOrder(): void {
  if (!sharedPlaylist || !currentShareId) return;
  try {
    const orders = JSON.parse(localStorage.getItem(SHARED_ORDER_KEY) ?? '{}') as Record<string, string[]>;
    orders[currentShareId] = sharedPlaylist.songs.map(song => song.id);
    localStorage.setItem(SHARED_ORDER_KEY, JSON.stringify(orders));
  } catch { /* The reordered view still lasts until the page is refreshed. */ }
}

async function loadReactions(shareId: string): Promise<void> {
  try {
    const response = await fetch(`/api/playlists/${encodeURIComponent(shareId)}/reactions?voter=${encodeURIComponent(voterId())}`);
    if (!response.ok) return;
    const result = await response.json() as { reactions?: Array<{ song_id: string; likes: number; dislikes: number; mine: number; latest: number }> };
    reactions = Object.fromEntries((result.reactions ?? []).map(item => [item.song_id, {
      likes: Number(item.likes) || 0,
      dislikes: Number(item.dislikes) || 0,
      mine: item.mine === 1 ? 1 : item.mine === -1 ? -1 : 0,
      latest: item.latest === 1 ? 1 : item.latest === -1 ? -1 : 0,
    }]));
    render();
  } catch { /* Reactions are supplementary; keep the playlist usable offline. */ }
}

async function loadPlays(shareId: string): Promise<void> {
  try {
    const response = await fetch(`/api/playlists/${encodeURIComponent(shareId)}/plays`);
    if (!response.ok) return;
    const result = await response.json() as { plays?: Array<{ song_id: string; play_count: number }> };
    plays = Object.fromEntries((result.plays ?? []).map(item => [item.song_id, Number(item.play_count) || 0]));
    render();
  } catch { /* Play counts are supplementary; keep the playlist usable offline. */ }
}

function loadOwnerReactions(playlistId: string): void {
  const shareId = shareKeys()[playlistId]?.id ?? manager.getPlaylist(playlistId)?.feedbackShareId;
  reactions = {};
  plays = {};
  if (shareId) { void loadReactions(shareId); void loadPlays(shareId); }
}

async function readSharedPlaylist(): Promise<Playlist | null> {
  const hash = new URLSearchParams(location.hash.slice(1));
  const shareId = hash.get('share');
  if (shareId) {
    try {
      currentShareId = shareId;
      const ownerToken = hash.get('owner');
      pendingOwnerToken = ownerToken && /^[a-zA-Z0-9_-]{32,120}$/.test(ownerToken) ? ownerToken : null;
      const response = await fetch(`/api/playlists/${encodeURIComponent(shareId)}`);
      if (!response.ok) return null;
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') return null;
      const playlist = (result as { playlist?: Partial<Playlist> }).playlist;
      if (!playlist || typeof playlist.name !== 'string' || !Array.isArray(playlist.songs) || !playlist.songs.every(isSong)) return null;
      const shared = { id: 'shared', name: playlist.name, songs: playlist.songs, createdAt: playlist.createdAt ?? new Date().toISOString(), theme: isTheme(playlist.theme) ? playlist.theme : 'mixtape', recipient: typeof playlist.recipient === 'string' ? playlist.recipient : '', sender: typeof playlist.sender === 'string' ? playlist.sender : '', dedication: typeof playlist.dedication === 'string' ? playlist.dedication : '' } satisfies Playlist;
      senderOrder = shared.songs.map(song => song.id);
      return applySharedOrder(shared, shareId);
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
    return { id: 'shared', name: data.name, songs: data.songs, createdAt: data.createdAt ?? new Date().toISOString(), theme: isTheme(data.theme) ? data.theme : 'mixtape', recipient: typeof data.recipient === 'string' ? data.recipient : '', sender: typeof data.sender === 'string' ? data.sender : '', dedication: typeof data.dedication === 'string' ? data.dedication : '' };
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

function songEmbed(song: Song): string | undefined {
  let inferred: string | undefined;
  try { inferred = ingestion.getEmbedUrl(new URL(song.url), song.source); } catch { /* Keep unsupported links as ordinary links. */ }
  return safeEmbed(song.embedUrl ?? inferred);
}

function autoplayEmbed(song: Song): string | undefined {
  const embed = songEmbed(song);
  if (!embed) return undefined;
  const url = new URL(embed);
  if (song.source === 'YouTube') {
    url.searchParams.set('autoplay', '1');
    url.searchParams.set('playsinline', '1');
    url.searchParams.set('enablejsapi', '1');
    url.searchParams.set('origin', location.origin);
  } else if (song.source === 'SoundCloud') {
    url.searchParams.set('auto_play', 'true');
  } else {
    url.searchParams.set('autoplay', '1');
  }
  return url.href;
}

function playableSongs(playlist: Playlist): Song[] { return playlist.songs.filter(song => songEmbed(song)); }

function playTapeButtonSound(): void {
  try {
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return;
    buttonAudio ??= new AudioContextClass();
    if (buttonAudio.state === 'suspended') void buttonAudio.resume();
    const now = buttonAudio.currentTime;
    const click = buttonAudio.createOscillator();
    const body = buttonAudio.createOscillator();
    const gain = buttonAudio.createGain();
    const filter = buttonAudio.createBiquadFilter();
    click.type = 'triangle'; click.frequency.setValueAtTime(1500, now); click.frequency.exponentialRampToValueAtTime(420, now + 0.035);
    body.type = 'sine'; body.frequency.setValueAtTime(125, now); body.frequency.exponentialRampToValueAtTime(72, now + 0.09);
    filter.type = 'lowpass'; filter.frequency.setValueAtTime(1900, now);
    gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.22, now + 0.004); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    click.connect(filter); body.connect(filter); filter.connect(gain); gain.connect(buttonAudio.destination);
    click.start(now); body.start(now); click.stop(now + 0.04); body.stop(now + 0.11);
  } catch { /* Sound is decorative; playback should still work if audio is unavailable. */ }
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
      body: JSON.stringify({ playlist: { name: playlist.name, songs: playlist.songs, createdAt: playlist.createdAt, theme: playlist.theme ?? 'mixtape', recipient: playlist.recipient ?? '', sender: playlist.sender ?? '', dedication: playlist.dedication ?? '' } }),
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
  if (active && isTheme(active.theme)) currentTheme = active.theme;
  document.documentElement.dataset.theme = currentTheme;
  document.title = `${themeLabels[currentTheme]} — Your music, together`;
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <div class="app-shell">
      <a class="skip-link" href="#main-content">Skip to playlist</a>
      <header class="topbar"><a class="brand" href="#" aria-label="${escapeHtml(themeLabels[currentTheme])} home">${formatLogo(currentTheme, false)}<span>${escapeHtml(themeLabels[currentTheme])}<span class="brand-period">.</span></span></a><span class="top-note">A little more together</span><label class="theme-control"><span>FORMAT</span><select id="theme-select" aria-label="Choose a visual theme" ${readonly ? 'disabled title="This is the format chosen for this shared mix"' : ''}>${themes.map(theme => `<option value="${theme}" ${currentTheme === theme ? 'selected' : ''}>${themeLabels[theme]}</option>`).join('')}</select></label><button class="button button-quiet" id="new-playlist">＋ <span>New playlist</span></button></header>
      <main class="layout">
        <aside class="sidebar"><div class="sidebar-heading"><span>Your library</span><span class="count-pill">${playlists.length}</span></div>
          <nav class="playlist-nav" aria-label="Your playlists">${playlists.length ? playlists.map(p => `<button class="playlist-nav-item ${p.id === active?.id ? 'selected' : ''}" data-open="${escapeHtml(p.id)}" title="${escapeHtml(p.name)}" ${p.id === active?.id ? 'aria-current="page"' : ''}>${formatLogo(isTheme(p.theme) ? p.theme : 'mixtape', false)}<span class="nav-name">${escapeHtml(p.name)}</span><span class="nav-count">${p.songs.length}</span></button>`).join('') : '<p class="sidebar-empty">Your playlists will live here.</p>'}</nav>
          <div class="sidebar-bottom"><div class="avatar">s</div><div><strong>Just you</strong><span>Saved on this device</span></div></div>
        </aside>
        <section class="content" id="main-content" tabindex="-1">
          ${notice ? `<div class="toast ${noticeKind === 'error' ? 'toast-error' : ''}" role="status">${escapeHtml(notice)}<button id="dismiss-notice" aria-label="Dismiss">×</button></div>` : ''}
          ${sharedPlaylist ? `<div class="shared-banner ${pendingOwnerToken ? 'owner-recovery-banner' : ''}"><span class="shared-icon">${pendingOwnerToken ? '⌁' : '↗'}</span><div><strong>${pendingOwnerToken ? 'Private recovery link opened' : 'Someone shared a playlist with you'}</strong><span>${pendingOwnerToken ? 'Restore this mix, its editing access, and recipient feedback to this browser.' : 'Reorder it your way and react to the tracks. Your order stays on this device.'}</span></div><button class="button button-dark" id="save-shared">${pendingOwnerToken ? 'Restore owner access' : 'Save a copy'}</button><button class="icon-button banner-close" id="close-shared" aria-label="Close shared playlist">×</button></div>` : ''}
          ${active ? playlistView(active, readonly) : welcomeView()}
        </section>
      </main>
      <footer class="footer"><span>Music links, all in one place.</span><span>Made for sharing <span class="heart">♥</span></span></footer>
      <dialog id="create-dialog" class="dialog"><form id="create-form"><button type="button" class="icon-button dialog-close" data-close aria-label="Close">×</button><span class="eyebrow">START A COLLECTION</span><h2>Make something for someone.</h2><p>Name the mix, personalize it, then choose the format that fits its feeling.</p><label for="playlist-name">Mix name</label><input id="playlist-name" name="name" maxlength="60" placeholder="Sunday morning, road trip…" required autofocus><div class="personal-fields"><label>Made for<input name="recipient" maxlength="40" placeholder="Their name"></label><label>Made by<input name="sender" maxlength="40" placeholder="Your name"></label><label class="dedication-field">Short dedication<input name="dedication" maxlength="140" placeholder="A few words just for them"></label></div><fieldset class="format-picker"><legend>Choose a format</legend>${themes.map(theme => `<label><input type="radio" name="theme" value="${theme}" ${currentTheme === theme ? 'checked' : ''}>${formatLogo(theme, true)}</label>`).join('')}</fieldset><div class="dialog-actions"><button type="button" class="button button-quiet" data-close>Cancel</button><button class="button button-dark" type="submit">Create mix <span>→</span></button></div></form></dialog>
      <dialog id="add-dialog" class="dialog"><form id="add-form"><button type="button" class="icon-button dialog-close" data-close aria-label="Close">×</button><span class="eyebrow">ADD TO YOUR PLAYLIST</span><h2>Bring a track along.</h2><p>Paste a YouTube playlist or add individual music links, with one URL on each line.</p><label for="song-urls">Track or playlist links</label><textarea id="song-urls" name="urls" rows="6" placeholder="https://youtube.com/playlist?list=…&#10;https://open.spotify.com/track/…" required></textarea><span class="field-hint">YouTube playlists · YouTube · Spotify · SoundCloud · Apple Music · Tidal</span><div class="dialog-actions"><button type="button" class="button button-quiet" data-close>Cancel</button><button class="button button-dark" type="submit">Add tracks <span>→</span></button></div></form></dialog>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>`;
  bindEvents();
}

function themeArtwork(theme: Theme, cover = false, playlist?: Playlist): string {
  const recipient = escapeHtml(playlist?.recipient?.trim() || 'you');
  const sender = escapeHtml(playlist?.sender?.trim() || '');
  const title = escapeHtml(playlist?.name?.trim() || themeLabels[theme]);
  const format = theme === 'side-a' ? 'record' : theme === 'cd-mix' ? 'CD mix' : theme === 'playlist' ? 'playlist' : 'mixtape';
  const byline = playlist ? `A ${format}${playlist.recipient?.trim() ? ` made for ${recipient}` : ''}${playlist.sender?.trim() ? ` by ${sender}` : ''}` : `A ${format} made for ${recipient}`;
  if (theme === 'mixtape') return `<div class="cassette-scene ${cover ? 'scene-small' : ''}" aria-hidden="true"><div class="j-card"><span>FOR:</span><b>${recipient}</b><i>01 ________</i><i>02 ________</i><i>03 ________</i><em>play loud</em></div><div class="cassette-art ${cover ? 'cassette-small' : ''}"><div class="cassette-screw screw-a"></div><div class="cassette-screw screw-b"></div><div class="cassette-window"><i class="tape-reel reel-left"></i><i class="tape-pack tape-pack-left"></i><i class="tape-pack tape-pack-right"></i><i class="tape-reel reel-right"></i></div><div class="cassette-label"><b>${title}</b><span>${byline}</span></div><div class="cassette-holes"><i></i><i></i><i></i><i></i></div><div class="cassette-brand"><span>SIDE A</span><span>${tapeLength(playlist)}</span></div></div></div>`;
  if (theme === 'cd-mix') return `<div class="cd-scene ${cover ? 'scene-small' : ''}" aria-hidden="true"><div class="cd-booklet"><b>${title}</b><span>${byline}</span><span>01 play it again</span><span>02 all the way home</span></div><div class="cd-case ${cover ? 'cd-small' : ''}"><div class="cd-disc"><div class="cd-marker"><b>${title}</b><span>${byline}</span></div><div class="cd-hub"><span>CD<br>MIX</span></div><div class="cd-shine"></div></div><div class="cd-sticker">VOL. 01</div><div class="cd-track-lines"><i></i><i></i><i></i></div></div></div>`;
  if (theme === 'playlist') return `<div class="player-scene ${cover ? 'scene-small' : ''}" aria-hidden="true"><div class="queue-card queue-one"><span>UP NEXT</span><b>02</b></div><div class="queue-card queue-two"><span>IN THE MIX</span><b>03</b></div><div class="player-art ${cover ? 'player-small' : ''}"><div class="player-top"><span>FOR ${recipient.toUpperCase()}</span><b>•••</b></div><div class="player-album"><span>♫</span></div><div class="player-song"><b>${title}</b><span>${byline}</span></div><div class="player-progress"><i></i></div><div class="player-bars">${'<i></i>'.repeat(13)}</div><div class="player-controls"><span>↶</span><b>▶</b><span>↷</span></div></div></div>`;
  return `<div class="record-scene ${cover ? 'scene-small' : ''}" aria-hidden="true"><div class="record-sleeve"><span>${byline}</span><b>${title}</b><i>33⅓ RPM</i></div><div class="art-disc"><div class="disc-label"><span>${recipient}</span><b>♥</b></div></div><div class="tonearm"><i></i></div></div><div class="art-note note-one"><span>♫</span> good things take time</div><div class="art-note note-two">your mix, your people <span>↗</span></div><span class="art-spark spark-one">✳</span><span class="art-spark spark-two">✳</span><div class="art-caption">PLAY IT YOUR WAY <span>— No. 001</span></div>`;
}

function welcomeView(): string {
  const intro: Record<Theme, { eyebrow: string; title: string; copy: string; button: string; caption: string }> = {
    'side-a': { eyebrow: 'YOUR MUSIC, TOGETHER', title: 'Every song has<br>a <em>place.</em>', copy: "Collect the tracks you love from all over the internet. Make a playlist, pass it along, and make someone's day.", button: 'Make a playlist', caption: 'A little more together' },
    mixtape: { eyebrow: 'RECORDED WITH YOU IN MIND', title: 'A mix made<br><em>just for you.</em>', copy: 'Like a mixtape passed across the room: a few favorite songs, a handwritten note, and a little bit of meaning.', button: 'Make a mixtape', caption: 'PRESS PLAY · SIDE A' },
    'cd-mix': { eyebrow: 'A COLLECTION, BURNED BRIGHT', title: 'Your songs,<br><em>in rotation.</em>', copy: 'Build a jewel-case-worthy collection from every music service, complete with the tracks and notes that make it yours.', button: 'Make a CD mix', caption: 'COMPACT MEMORIES · VOL. 01' },
    playlist: { eyebrow: 'MUSIC FOR THIS MOMENT', title: 'Set the mood.<br><em>Press play.</em>', copy: 'Gather the links you keep coming back to and send someone a soundtrack for wherever they are.', button: 'Make a playlist', caption: 'A MIX FOR RIGHT NOW' },
  };
  const content = intro[currentTheme];
  return `<div class="welcome"><div class="welcome-copy"><span class="eyebrow">${content.eyebrow}</span><h1>${content.title}</h1><p>${content.copy}</p><div class="welcome-actions"><button class="button button-dark button-large" id="welcome-create">${content.button} <span>→</span></button><button class="button button-quiet import-trigger" id="import-trigger">Import playlist</button></div><div class="source-row"><span>Works with</span><span class="source-chip">YouTube</span><span class="source-chip">Spotify</span><span class="source-chip">SoundCloud</span><span class="source-chip">Apple Music</span><span class="source-chip">Tidal</span></div></div><div class="art-card theme-art theme-art-${currentTheme}"><div class="art-format-logo">${formatLogo(currentTheme)}</div>${themeArtwork(currentTheme)}${currentTheme !== 'side-a' ? `<div class="theme-art-caption">${content.caption}</div>` : ''}</div><div class="how-strip"><span class="how-item"><b>01</b><span>Collect links from the places you listen</span></span><span class="how-divider"></span><span class="how-item"><b>02</b><span>Add your own titles and notes</span></span><span class="how-divider"></span><span class="how-item"><b>03</b><span>Share a link with someone you love</span></span></div></div>`;
}

function playlistView(playlist: Playlist, readonly: boolean): string {
  const songs = playlist.songs;
  const coverLabel: Record<Theme, string> = { 'side-a': 'A SIDE ORIGINAL', mixtape: playlist.recipient?.trim() ? `MIXED FOR ${escapeHtml(playlist.recipient.trim())} · 90 MIN` : 'YOUR MIX · 90 MIN', 'cd-mix': 'COMPACT MEMORIES · VOL. 01', playlist: 'NOW PLAYING · YOUR MIX' };
  const description: Record<Theme, string> = { 'side-a': 'A collection of good things, gathered in one place.', mixtape: 'A little handwritten feeling, set to a favorite side.', 'cd-mix': 'A keepsake collection, ready for another spin.', playlist: 'A soundtrack for right here, right now.' };
  const cover = themeArtwork(currentTheme, true, playlist);
  const customDedication = playlist.dedication?.trim() ?? '';
  const dedication = customDedication || description[currentTheme];
  const dedicationNote = customDedication ? `<aside class="cover-dedication"><span>A NOTE FROM ${escapeHtml((playlist.sender?.trim() || 'THE SENDER').toUpperCase())}</span><p>${escapeHtml(customDedication)}</p></aside>` : '';
  const duration = playlistDuration(playlist);
  const durationMeta = duration.seconds ? ` <span class="meta-separator">·</span> ${formatDuration(duration.seconds)}${duration.complete ? '' : '+'}` : '';
  const knownDurations = playlist.songs.filter(song => song.durationSeconds && song.durationSeconds > 0).length;
  const durationHelp = !readonly && playlist.songs.length && !duration.complete
    ? `<p class="duration-help"><b>${knownDurations} of ${playlist.songs.length}</b> track lengths known. Play each YouTube track once or enter its length as <strong>m:ss</strong>.</p>` : '';
  const canPlay = playableSongs(playlist).length > 0;
  const ownerCredentials = !readonly && currentId ? shareKeys()[currentId] : undefined;
  const listenButton = canPlay ? `<button class="button button-play" id="play-mix">▶ <span>${playerOpen && playerPlaylistId === playlist.id ? 'Restart mix' : 'Play mix'}</span></button>` : '';
  return `<div class="playlist-page">
    <div class="playlist-cover theme-cover theme-cover-${currentTheme} ${customDedication ? 'has-dedication' : ''}"><div class="cover-format-logo">${formatLogo(currentTheme)}</div>${dedicationNote}${cover}<span class="cover-label">${coverLabel[currentTheme]}</span></div>
    <div class="playlist-heading">
      <div class="playlist-heading-top"><span class="eyebrow">${readonly ? 'SHARED WITH YOU' : 'YOUR COLLECTION'}</span><div class="heading-actions">${!readonly ? `<button class="button button-outline" id="export-playlist">↓ <span>Export</span></button><button class="button button-outline" id="share-playlist">↗ <span>Copy live link</span></button>${ownerCredentials ? '<button class="button button-outline" id="copy-recovery-link">⌁ <span>Recovery link</span></button>' : ''}<button class="button button-outline danger-button" id="delete-playlist" aria-label="Delete playlist">× <span>Delete</span></button>` : ''}</div></div>
      <h1>${escapeHtml(playlist.name)}</h1>
      <p class="playlist-meta"><span class="avatar tiny">${readonly ? '♥' : 's'}</span> ${playlist.recipient ? `Made for <strong>${escapeHtml(playlist.recipient)}</strong>` : readonly ? 'Shared by someone' : 'Your collection'}${playlist.sender ? ` by <strong>${escapeHtml(playlist.sender)}</strong>` : ''} <span class="meta-separator">·</span> ${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}${durationMeta}</p>
      ${customDedication ? '' : `<p class="playlist-description">${escapeHtml(dedication)}</p>`}
      ${!readonly ? `<div class="personalize-mix"><label>Made for<input id="recipient-name" maxlength="40" value="${escapeHtml(playlist.recipient ?? '')}" placeholder="Add their name"></label><label>Made by<input id="sender-name" maxlength="40" value="${escapeHtml(playlist.sender ?? '')}" placeholder="Add your name"></label><label class="dedication-field">Dedication<input id="playlist-dedication" maxlength="140" value="${escapeHtml(playlist.dedication ?? '')}" placeholder="Write a few words"></label><span>Saved automatically</span></div>` : ''}
      <div class="playlist-main-actions">${listenButton}${readonly && currentShareId ? `<button class="button button-quiet" id="reset-shared-order">↺ <span>Original order</span></button>` : ''}${!readonly ? `<button class="button button-dark" id="add-track">＋ <span>Add tracks</span></button><button class="button button-quiet" id="sort-playlist">↕ <span>Sort A–Z</span></button><button class="button button-quiet" id="import-trigger">↑ <span>Import file</span></button>` : ''}</div>
      ${durationHelp}
    </div>
    ${playerOpen && playerPlaylistId === playlist.id ? queuePlayer(playlist) : ''}
    <section class="track-section"><div class="track-header"><span class="track-number">ORDER</span><span>TITLE ${readonly ? '' : '<i>click to edit</i>'}</span><span>SERVICE</span><span>PLAY</span><span></span></div>${songs.length ? songs.map((song, index) => trackRow(song, index, readonly, songs.length)).join('') : `<div class="empty-tracks"><div class="empty-vinyl">♫</div><strong>This playlist is waiting for a first track.</strong><span>${readonly ? 'It looks like this one is empty.' : 'Paste one link or a whole list from your music apps.'}</span>${!readonly ? '<button class="button button-outline" id="add-first">Add tracks →</button>' : ''}</div>`}</section>
    <div class="playlist-endnote"><span>✳</span> A good playlist is a little piece of you.</div>
  </div>`;
}

function queuePlayer(playlist: Playlist): string {
  const queue = playableSongs(playlist);
  const active = queue.find(song => song.id === playerTrackId) ?? queue[0];
  if (!active) return '';
  playerTrackId = active.id;
  const index = queue.findIndex(song => song.id === active.id);
  const embed = autoplayEmbed(active);
  const artwork = safeArtwork(active.artworkUrl);
  const sourceClass = active.source.toLowerCase().replace(/\s/g, '-');
  return `<section class="queue-player source-${sourceClass}" aria-label="Playlist player" aria-live="polite">
    <div class="queue-player-bar">
      <div class="queue-art">${artwork ? `<img src="${escapeHtml(artwork)}" alt="">` : '<span>♫</span>'}</div>
      <div class="queue-copy"><span>NOW PLAYING · ${index + 1} OF ${queue.length}</span><strong>${escapeHtml(active.title)}</strong><small>${escapeHtml(active.artist || active.source)}</small></div>
      <div class="queue-controls"><button class="icon-button" id="player-prev" aria-label="Previous playable track">←</button><a class="queue-source" href="${escapeHtml(active.url)}" target="_blank" rel="noreferrer">Open in ${escapeHtml(active.source)}</a><button class="icon-button" id="player-next" aria-label="Next playable track">→</button><button class="icon-button queue-close" id="close-player" aria-label="Close player">×</button></div>
    </div>
    ${embed ? `<iframe class="queue-frame" ${active.source === 'YouTube' ? `id="youtube-queue-player" data-youtube-duration-song="${escapeHtml(active.id)}"` : ''} src="${escapeHtml(embed)}" title="Now playing ${escapeHtml(active.title)} by ${escapeHtml(active.artist || active.source)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allowfullscreen></iframe>` : ''}
    <p class="queue-help">Use the player’s own play and pause controls. Previous and next move through every playable track in this mix.</p>
  </section>`;
}

function trackRow(song: Song, index: number, readonly: boolean, playlistLength: number): string {
  const artwork = safeArtwork(song.artworkUrl);
  const embed = songEmbed(song);
  const active = playerOpen && playerTrackId === song.id;
  const reorderable = !readonly || !!currentShareId;
  const reaction = reactions[song.id] ?? { likes: 0, dislikes: 0, mine: 0, latest: 0 };
  const hasFeedbackSource = !!currentId && !!(shareKeys()[currentId]?.id ?? manager.getPlaylist(currentId)?.feedbackShareId);
  const ownerReaction = reaction.latest === 1
    ? '<div class="reaction-status reaction-liked" aria-label="Recipient liked this track"><span aria-hidden="true">👍</span> Liked</div>'
    : reaction.latest === -1
      ? '<div class="reaction-status reaction-disliked" aria-label="Recipient did not like this track"><span aria-hidden="true">👎</span> Not for me</div>'
      : '<div class="reaction-status reaction-pending" aria-label="No recipient reaction yet"><span aria-hidden="true">○</span> No reaction yet</div>';
  const playCount = plays[song.id] ?? 0;
  const ownerActivity = `<div class="owner-activity">${ownerReaction}<div class="play-count" aria-label="${playCount} ${playCount === 1 ? 'play' : 'plays'}"><span aria-hidden="true">▶</span> ${playCount} ${playCount === 1 ? 'play' : 'plays'}</div></div>`;
  const feedback = currentShareId
    ? `<div class="reaction-buttons" role="group" aria-label="Your reaction to ${escapeHtml(song.title)}"><span class="reaction-label">DID YOU LIKE IT?</span><button class="reaction-button reaction-up ${reaction.mine === 1 ? 'selected' : ''}" data-react="${escapeHtml(song.id)}" data-reaction="1" aria-label="Like ${escapeHtml(song.title)}" aria-pressed="${reaction.mine === 1}"><b aria-hidden="true">👍</b><span>Like</span></button><button class="reaction-button reaction-down ${reaction.mine === -1 ? 'selected' : ''}" data-react="${escapeHtml(song.id)}" data-reaction="-1" aria-label="Dislike ${escapeHtml(song.title)}" aria-pressed="${reaction.mine === -1}"><b aria-hidden="true">👎</b><span>Not for me</span></button></div>`
    : (!readonly && hasFeedbackSource) ? ownerActivity : '';
  const durationControl = readonly
    ? (song.durationSeconds ? `<span class="track-duration">${formatDuration(song.durationSeconds)}</span>` : '')
    : `<label class="duration-editor">Length <input data-duration-song="${escapeHtml(song.id)}" value="${formatDuration(song.durationSeconds)}" placeholder="3:45" inputmode="numeric" aria-label="Length of ${escapeHtml(song.title)} in minutes and seconds"></label>`;
  const actions = reorderable ? `<div class="track-actions"><button class="icon-button move-track" data-move="${escapeHtml(song.id)}" data-offset="-1" aria-label="Move ${escapeHtml(song.title)} up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-button move-track" data-move="${escapeHtml(song.id)}" data-offset="1" aria-label="Move ${escapeHtml(song.title)} down" ${index === playlistLength - 1 ? 'disabled' : ''}>↓</button>${!readonly ? `<button class="icon-button remove-track" data-remove="${escapeHtml(song.id)}" aria-label="Remove ${escapeHtml(song.title)}">×</button>` : ''}</div>` : '<span class="track-actions-spacer"></span>';
  return `<div class="track-item ${active ? 'is-playing' : ''}"><article class="track-row" data-track="${escapeHtml(song.id)}" ${reorderable ? 'draggable="true"' : ''}><span class="track-number">${reorderable ? '<i class="drag-grip" aria-hidden="true">⠿</i>' : ''}<b>${String(index + 1).padStart(2, '0')}</b></span><div class="track-details"><div class="track-icon ${song.source.toLowerCase().replace(/\s/g, '-')}" aria-hidden="true">${artwork ? `<img src="${escapeHtml(artwork)}" alt="" loading="lazy" decoding="async">` : song.source === 'YouTube' ? '▶' : song.source === 'Spotify' ? '◉' : song.source === 'Apple Music' ? '♫' : song.source === 'Tidal' ? '▦' : '☁'}</div><div class="track-text"><textarea class="song-title" data-song="${escapeHtml(song.id)}" data-field="title" aria-label="Track title" rows="1" ${readonly ? 'readonly' : ''}>${escapeHtml(song.title)}</textarea><input class="song-artist" data-song="${escapeHtml(song.id)}" data-field="artist" aria-label="Artist" placeholder="Add artist name" value="${escapeHtml(song.artist)}" ${readonly ? 'readonly' : ''}>${durationControl}${feedback}</div></div><span class="service-name">${escapeHtml(song.source)}</span>${embed ? `<button class="link-button play-track" data-play-track="${escapeHtml(song.id)}" aria-label="Play ${escapeHtml(song.title)}">${active ? '●' : '▶'} <span>${active ? 'Playing' : 'Play'}</span></button>` : `<a class="link-button" data-open-track="${escapeHtml(song.id)}" href="${escapeHtml(song.url)}" target="_blank" rel="noreferrer" title="Open track link">↗ <span>Open</span></a>`}${actions}</article></div>`;
}

async function recordPlay(songId: string): Promise<void> {
  if (!sharedPlaylist || !currentShareId) return;
  try {
    await fetch(`/api/playlists/${encodeURIComponent(currentShareId)}/plays`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId }), keepalive: true,
    });
  } catch { /* Counting should never interrupt listening. */ }
}

function startPlayer(trackId?: string): void {
  const playlist = currentPlaylist();
  if (!playlist) return;
  const queue = playableSongs(playlist);
  if (!queue.length) {
    notice = 'This mix does not have any tracks that can play inside the page yet.';
    noticeKind = 'error'; render(); return;
  }
  playerPlaylistId = playlist.id;
  playerTrackId = queue.some(song => song.id === trackId) ? trackId! : queue[0].id;
  void recordPlay(playerTrackId);
  playTapeButtonSound();
  if (document.querySelector('.queue-player') && playerPlaylistId === playlist.id) {
    updateQueuePlayer(playlist);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.queue-player')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    return;
  }
  playerOpen = true;
  render();
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.queue-player')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

function stepPlayer(offset: -1 | 1): void {
  const playlist = currentPlaylist();
  if (!playlist) return;
  const queue = playableSongs(playlist);
  if (!queue.length) return;
  const current = Math.max(0, queue.findIndex(song => song.id === playerTrackId));
  playerTrackId = queue[(current + offset + queue.length) % queue.length].id;
  void recordPlay(playerTrackId);
  updateQueuePlayer(playlist);
  requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(offset < 0 ? '#player-prev' : '#player-next')?.focus());
}

function updateQueuePlayer(playlist: Playlist): void {
  const player = document.querySelector<HTMLElement>('.queue-player');
  if (!player) { render(); return; }
  const next = document.createElement('div');
  next.innerHTML = queuePlayer(playlist);
  const updated = next.firstElementChild;
  if (updated) player.replaceWith(updated);
  bindPlayerEvents();
  document.querySelectorAll<HTMLElement>('.track-item').forEach(item => {
    const isPlaying = item.querySelector<HTMLElement>('[data-play-track]')?.dataset.playTrack === playerTrackId;
    item.classList.toggle('is-playing', !!isPlaying);
    const button = item.querySelector<HTMLButtonElement>('[data-play-track]');
    if (button) { button.innerHTML = isPlaying ? '● <span>Playing</span>' : '▶ <span>Play</span>'; }
  });
  const mixButton = document.querySelector<HTMLButtonElement>('#play-mix');
  if (mixButton) mixButton.innerHTML = `▶ <span>Restart mix</span>`;
}

function bindPlayerEvents(): void {
  document.querySelector('#player-prev')?.addEventListener('click', () => stepPlayer(-1));
  document.querySelector('#player-next')?.addEventListener('click', () => stepPlayer(1));
  document.querySelector('#close-player')?.addEventListener('click', closePlayer);
  void captureYouTubeDuration();
}

function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT); else reject(new Error('YouTube player API did not load.'));
    };
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.async = true; script.onerror = () => reject(new Error('YouTube player API could not be loaded.'));
    document.head.appendChild(script);
  });
  return youtubeApiPromise;
}

async function captureYouTubeDuration(): Promise<void> {
  if (!currentId || sharedPlaylist) return;
  const iframe = document.querySelector<HTMLIFrameElement>('[data-youtube-duration-song]');
  const songId = iframe?.dataset.youtubeDurationSong;
  const song = songId ? manager.getPlaylist(currentId)?.songs.find(item => item.id === songId) : undefined;
  if (!iframe || !songId || !song || song.durationSeconds) return;
  try {
    const api = await loadYouTubeApi();
    activeYouTubePlayer?.destroy();
    activeYouTubePlayer = new api.Player(iframe, { events: { onReady: event => {
      let attempts = 0;
      const read = (): void => {
        const seconds = event.target.getDuration();
        if (seconds > 0 && currentId) {
          manager.updateSongDuration(currentId, songId, seconds); void syncCurrentShare(); render(); return;
        }
        if (++attempts < 8) setTimeout(read, 500);
      };
      read();
    } } });
  } catch { /* Manual duration entry remains available. */ }
}

function closePlayer(): void {
  playerOpen = false; playerTrackId = null; playerPlaylistId = null; render();
  requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#play-mix')?.focus());
}

function moveSharedSong(songId: string, offset?: -1 | 1, targetId?: string): void {
  if (!sharedPlaylist) return;
  const from = sharedPlaylist.songs.findIndex(song => song.id === songId);
  const to = targetId ? sharedPlaylist.songs.findIndex(song => song.id === targetId) : from + (offset ?? 0);
  if (from < 0 || to < 0 || to >= sharedPlaylist.songs.length || from === to) return;
  const [song] = sharedPlaylist.songs.splice(from, 1);
  sharedPlaylist.songs.splice(to, 0, song);
  saveSharedOrder();
  notice = 'Your track order is saved on this device.'; noticeKind = 'success'; render();
}

function resetSharedOrder(): void {
  if (!sharedPlaylist || !currentShareId) return;
  const positions = new Map(senderOrder.map((id, index) => [id, index]));
  sharedPlaylist.songs.sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  try {
    const orders = JSON.parse(localStorage.getItem(SHARED_ORDER_KEY) ?? '{}') as Record<string, string[]>;
    delete orders[currentShareId]; localStorage.setItem(SHARED_ORDER_KEY, JSON.stringify(orders));
  } catch { /* The sender's order is still restored for this visit. */ }
  notice = 'Restored the sender’s original order.'; noticeKind = 'success'; render();
}

async function setReaction(songId: string, requested: -1 | 1): Promise<void> {
  if (!currentShareId) return;
  const current = reactions[songId]?.mine ?? 0;
  const reaction = current === requested ? 0 : requested;
  try {
    const response = await fetch(`/api/playlists/${encodeURIComponent(currentShareId)}/reactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId, voterId: voterId(), reaction }),
    });
    if (!response.ok) throw new Error();
    await loadReactions(currentShareId);
  } catch {
    notice = 'Your reaction could not be saved. Try again in a moment.'; noticeKind = 'error'; render();
  }
}

function bindEvents(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.querySelector<HTMLSelectElement>('#theme-select')?.addEventListener('change', event => {
    const selected = (event.currentTarget as HTMLSelectElement).value;
    if (!themes.includes(selected as Theme)) return;
    currentTheme = selected as Theme;
    if (currentId && !sharedPlaylist) { manager.updateTheme(currentId, currentTheme); void syncCurrentShare(); }
    try { localStorage.setItem(THEME_KEY, currentTheme); } catch { /* Keep the choice for this page view. */ }
    render();
  });
  app.querySelectorAll<HTMLElement>('[data-open]').forEach(el => el.addEventListener('click', () => { currentId = el.dataset.open!; sharedPlaylist = null; currentShareId = null; playerOpen = false; playerTrackId = null; playerPlaylistId = null; notice = ''; loadOwnerReactions(currentId); render(); }));
  app.querySelector('#new-playlist')?.addEventListener('click', openCreate);
  app.querySelector('#welcome-create')?.addEventListener('click', openCreate);
  app.querySelectorAll('#add-track, #add-first').forEach(el => el.addEventListener('click', () => (document.querySelector<HTMLDialogElement>('#add-dialog')!).showModal()));
  app.querySelector('#sort-playlist')?.addEventListener('click', () => withPlaylist(id => manager.sortPlaylist(id), 'Tracks sorted by artist, then title.'));
  app.querySelector('#play-mix')?.addEventListener('click', () => startPlayer());
  app.querySelector('#reset-shared-order')?.addEventListener('click', resetSharedOrder);
  app.querySelectorAll<HTMLButtonElement>('[data-react]').forEach(button => button.addEventListener('click', () => void setReaction(button.dataset.react!, Number(button.dataset.reaction) as -1 | 1)));
  app.querySelectorAll<HTMLElement>('[data-play-track]').forEach(button => button.addEventListener('click', () => startPlayer(button.dataset.playTrack)));
  app.querySelectorAll<HTMLElement>('[data-open-track]').forEach(link => link.addEventListener('click', () => void recordPlay(link.dataset.openTrack!)));
  bindPlayerEvents();
  app.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button => button.addEventListener('click', () => {
    if (sharedPlaylist) { moveSharedSong(button.dataset.move!, Number(button.dataset.offset) as -1 | 1); return; }
    if (currentId) { manager.moveSong(currentId, button.dataset.move!, Number(button.dataset.offset) as -1 | 1); notice = 'Track order updated.'; void syncCurrentShare(); render(); }
  }));
  let draggedTrack = '';
  app.querySelectorAll<HTMLElement>('[data-track][draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', event => {
      draggedTrack = row.dataset.track ?? '';
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', draggedTrack);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', event => { event.preventDefault(); if (row.dataset.track !== draggedTrack) row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', event => {
      event.preventDefault();
      const target = row.dataset.track ?? '';
      if (!draggedTrack || !target || draggedTrack === target) return;
      if (sharedPlaylist) { moveSharedSong(draggedTrack, undefined, target); return; }
      if (currentId) { manager.moveSongTo(currentId, draggedTrack, target); notice = 'Track order updated.'; void syncCurrentShare(); render(); }
    });
    row.addEventListener('dragend', () => { draggedTrack = ''; row.classList.remove('dragging'); app.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target')); });
  });
  app.querySelector('#share-playlist')?.addEventListener('click', sharePlaylist);
  app.querySelector('#copy-recovery-link')?.addEventListener('click', copyRecoveryLink);
  app.querySelector('#export-playlist')?.addEventListener('click', exportPlaylist);
  app.querySelector('#delete-playlist')?.addEventListener('click', deletePlaylist);
  app.querySelector('#save-shared')?.addEventListener('click', saveShared);
  app.querySelector('#close-shared')?.addEventListener('click', () => { sharedPlaylist = null; currentShareId = null; pendingOwnerToken = null; reactions = {}; plays = {}; history.replaceState(null, '', location.pathname + location.search); render(); });
  app.querySelectorAll('#import-trigger').forEach(el => el.addEventListener('click', () => document.querySelector<HTMLInputElement>('#import-file')!.click()));
  app.querySelector('#dismiss-notice')?.addEventListener('click', () => { notice = ''; render(); });
  app.querySelectorAll<HTMLElement>('[data-close]').forEach(el => el.addEventListener('click', () => el.closest('dialog')?.close()));
  app.querySelector<HTMLFormElement>('#create-form')?.addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
    try {
      const selectedTheme = isTheme(data.get('theme')) ? data.get('theme') as Theme : currentTheme;
      const playlist = manager.createPlaylist(String(data.get('name') ?? ''), selectedTheme, String(data.get('recipient') ?? ''), String(data.get('dedication') ?? ''), String(data.get('sender') ?? ''));
      currentTheme = selectedTheme; currentId = playlist.id; notice = 'Mix created. Add the first track when you’re ready.'; (document.querySelector<HTMLDialogElement>('#create-dialog')!).close(); render();
    }
    catch (error) { showError(error); }
  });
  const recipientInput = app.querySelector<HTMLInputElement>('#recipient-name');
  const senderInput = app.querySelector<HTMLInputElement>('#sender-name');
  const dedicationInput = app.querySelector<HTMLInputElement>('#playlist-dedication');
  [recipientInput, senderInput, dedicationInput].forEach(input => input?.addEventListener('change', () => {
    if (!currentId || sharedPlaylist) return;
    manager.updateDetails(currentId, recipientInput?.value ?? '', dedicationInput?.value ?? '', senderInput?.value ?? '');
    notice = 'Personalization updated.'; void syncCurrentShare(); render();
  }));
  app.querySelector<HTMLFormElement>('#add-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const data = new FormData(form); const playlist = currentPlaylist();
    if (!playlist || sharedPlaylist) return;
    const lines = String(data.get('urls') ?? '').split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) { showError(new Error('Paste at least one music link.')); return; }
    if (submit) { submit.disabled = true; submit.innerHTML = 'Adding…'; }
    const added: Song[] = [];
    const rejected: Array<{ line: string; message: string }> = [];
    let truncated = false;
    const results = await Promise.all(lines.map(async line => {
      try { return { line, result: await ingestion.ingestSongsFromLink(line), error: '' }; }
      catch (error) { return { line, result: null, error: error instanceof Error ? error.message : 'This link could not be imported.' }; }
    }));
    results.forEach(({ line, result, error }) => {
      if (result) { added.push(...result.songs); truncated ||= !!result.truncated; }
      else rejected.push({ line, message: error });
    });
    if (!added.length) {
      if (submit) { submit.disabled = false; submit.innerHTML = 'Add tracks <span>→</span>'; }
      showError(new Error(rejected[0]?.message ?? 'No supported music links found. Check the URLs and try again.')); return;
    }
    manager.addSongs(playlist.id, added);
    void syncCurrentShare();
    notice = truncated
      ? `Added the first ${added.length} tracks. This playlist is larger than the 500-track import limit.`
      : rejected.length
        ? `Added ${added.length} ${added.length === 1 ? 'track' : 'tracks'}; skipped ${rejected.length} ${rejected.length === 1 ? 'link' : 'links'}.`
        : `Added ${added.length} ${added.length === 1 ? 'track' : 'tracks'} with available details filled in.`;
    noticeKind = truncated || rejected.length ? 'error' : 'success';
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
  app.querySelectorAll<HTMLInputElement>('[data-duration-song]').forEach(input => input.addEventListener('change', () => {
    if (!currentId || sharedPlaylist) return;
    const seconds = parseDuration(input.value);
    if (input.value.trim() && !seconds) {
      notice = 'Enter a track length as minutes and seconds, such as 3:45.'; noticeKind = 'error'; render(); return;
    }
    try {
      manager.updateSongDuration(currentId, input.dataset.durationSong!, seconds);
      notice = seconds ? 'Track length updated.' : 'Track length cleared.'; noticeKind = 'success'; void syncCurrentShare(); render();
    } catch (error) { showError(error); }
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
        body: JSON.stringify({ playlist: { name: playlist.name, songs: playlist.songs, createdAt: playlist.createdAt, theme: playlist.theme ?? 'mixtape', recipient: playlist.recipient ?? '', sender: playlist.sender ?? '', dedication: playlist.dedication ?? '' } }),
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
    void loadReactions(credentials.id);
  } catch {
    notice = 'Could not create a live share link. Run the app with the Cloudflare Pages local server and check the D1 setup.';
    noticeKind = 'error';
  }
  render();
}

async function saveShared(): Promise<void> {
  if (!sharedPlaylist) return;
  const sourceShareId = currentShareId;
  const ownerToken = pendingOwnerToken;
  if (sourceShareId && ownerToken) {
    try {
      const response = await fetch(`/api/playlists/${encodeURIComponent(sourceShareId)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` },
      });
      if (!response.ok) throw new Error();
    } catch {
      pendingOwnerToken = null;
      notice = 'This private recovery link is invalid or has been replaced.'; noticeKind = 'error'; render(); return;
    }
  }
  const copy = manager.createPlaylist(sharedPlaylist.name, sharedPlaylist.theme ?? 'mixtape', sharedPlaylist.recipient ?? '', sharedPlaylist.dedication ?? '', sharedPlaylist.sender ?? '');
  manager.addSongs(copy.id, sharedPlaylist.songs.map(song => ({ ...song })));
  if (sourceShareId) manager.setFeedbackShareId(copy.id, sourceShareId);
  if (sourceShareId && ownerToken) {
    const keys = shareKeys();
    localStorage.setItem(SHARE_KEYS, JSON.stringify({ ...keys, [copy.id]: { id: sourceShareId, token: ownerToken } }));
  }
  currentId = copy.id; sharedPlaylist = null; currentShareId = null; pendingOwnerToken = null;
  history.replaceState(null, '', location.pathname + location.search);
  notice = ownerToken ? 'Owner access restored. Keep your private recovery link somewhere safe.' : 'Saved a copy linked to this playlist’s feedback.';
  noticeKind = 'success'; loadOwnerReactions(copy.id); render();
}

async function copyRecoveryLink(): Promise<void> {
  if (!currentId) return;
  const credentials = shareKeys()[currentId];
  if (!credentials) return;
  const params = new URLSearchParams({ share: credentials.id, owner: credentials.token });
  const url = `${location.origin}${location.pathname}#${params.toString()}`;
  try {
    await navigator.clipboard.writeText(url);
    notice = 'Private recovery link copied. Anyone with this link can edit the mix, so keep it secret.';
  } catch {
    prompt('Copy your private recovery link and keep it secret:', url);
    notice = 'Recovery link ready. Keep it somewhere safe outside this browser.';
  }
  noticeKind = 'success'; render();
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
    const playlist = manager.createPlaylist(data.name, isTheme(data.theme) ? data.theme : 'mixtape', typeof data.recipient === 'string' ? data.recipient : '', typeof data.dedication === 'string' ? data.dedication : '', typeof data.sender === 'string' ? data.sender : '');
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
  if (playlist && currentShareId) void loadReactions(currentShareId);
});

window.addEventListener('storage', event => {
  if (event.key !== PLAYLIST_STORAGE_KEY && event.key !== null) return;
  manager.reload();
  if (!sharedPlaylist && currentId && !manager.getPlaylist(currentId)) {
    currentId = manager.listPlaylists()[0]?.id ?? null;
  }
  notice = 'Your library was updated in another window.';
  noticeKind = 'success';
  render();
  if (!sharedPlaylist && currentId) loadOwnerReactions(currentId);
});
