import type { Playlist, PlaylistTheme, Song } from './models';

export const PLAYLIST_STORAGE_KEY = 'side-a.playlists.v1';
const createId = (): string => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export type LibraryChange = { type: 'upsert'; playlist: Playlist } | { type: 'delete'; id: string; deletedAt: string };

function readPlaylists(): Playlist[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Playlist => item && typeof item.id === 'string' &&
      typeof item.name === 'string' && Array.isArray(item.songs)).map(item => ({
        ...item,
        updatedAt: item.updatedAt ?? item.createdAt,
        theme: ['side-a', 'mixtape', 'cd-mix', 'playlist'].includes(item.theme ?? '') ? item.theme : 'mixtape',
      }));
  } catch { return []; }
}

export class PlaylistManager {
  private playlists = readPlaylists();
  private changeListener?: (change: LibraryChange) => void;
  listPlaylists(): Playlist[] { return this.playlists; }
  getPlaylist(id: string): Playlist | undefined { return this.playlists.find(playlist => playlist.id === id); }
  reload(): void { this.playlists = readPlaylists(); }
  setChangeListener(listener: (change: LibraryChange) => void): void { this.changeListener = listener; }

  replaceLibrary(playlists: Playlist[]): void {
    this.playlists = playlists.map(playlist => ({ ...playlist, updatedAt: playlist.updatedAt ?? playlist.createdAt }));
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(this.playlists));
  }

  createPlaylist(name: string, theme: PlaylistTheme = 'mixtape', recipient = '', dedication = '', sender = ''): Playlist {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('Give your playlist a name first.');
    if (cleanName.length > 60) throw new Error('Playlist names can be up to 60 characters.');
    this.reload();
    const now = new Date().toISOString();
    const playlist: Playlist = { id: createId(), name: cleanName, songs: [], createdAt: now, updatedAt: now, theme, recipient: recipient.trim().slice(0, 40), sender: sender.trim().slice(0, 40), dedication: dedication.trim().slice(0, 140) };
    this.playlists.unshift(playlist); this.save(playlist.id); return playlist;
  }

  addSong(playlistId: string, song: Song): void { this.requirePlaylist(playlistId).songs.push(song); this.save(playlistId); }

  addSongs(playlistId: string, songs: Song[]): void {
    if (!songs.length) return;
    this.requirePlaylist(playlistId).songs.push(...songs); this.save(playlistId);
  }

  updateTheme(playlistId: string, theme: PlaylistTheme): void { this.requirePlaylist(playlistId).theme = theme; this.save(playlistId); }

  setFeedbackShareId(playlistId: string, shareId: string): void {
    this.requirePlaylist(playlistId).feedbackShareId = shareId; this.save(playlistId);
  }

  setOwnerShareId(playlistId: string, shareId: string): void {
    const playlist = this.requirePlaylist(playlistId);
    playlist.ownerShareId = shareId;
    playlist.feedbackShareId = shareId;
    this.save(playlistId);
  }

  updateDetails(playlistId: string, recipient: string, dedication: string, sender = ''): void {
    const playlist = this.requirePlaylist(playlistId);
    playlist.recipient = recipient.trim().slice(0, 40);
    playlist.sender = sender.trim().slice(0, 40);
    playlist.dedication = dedication.trim().slice(0, 140);
    this.save(playlistId);
  }

  updateSong(playlistId: string, songId: string, updates: Pick<Song, 'title' | 'artist'>): void {
    const song = this.requirePlaylist(playlistId).songs.find(item => item.id === songId);
    if (!song) throw new Error('That track is no longer in this playlist.');
    song.title = updates.title.trim() || 'Untitled track'; song.artist = updates.artist.trim(); this.save(playlistId);
  }

  updateSongDuration(playlistId: string, songId: string, durationSeconds?: number): void {
    const song = this.requirePlaylist(playlistId).songs.find(item => item.id === songId);
    if (!song) throw new Error('That track is no longer in this playlist.');
    song.durationSeconds = durationSeconds && durationSeconds > 0 ? Math.round(durationSeconds) : undefined;
    this.save(playlistId);
  }

  removeSong(playlistId: string, songId: string): void {
    const playlist = this.requirePlaylist(playlistId); playlist.songs = playlist.songs.filter(song => song.id !== songId); this.save(playlistId);
  }

  moveSong(playlistId: string, songId: string, offset: -1 | 1): void {
    const songs = this.requirePlaylist(playlistId).songs;
    const from = songs.findIndex(song => song.id === songId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= songs.length) return;
    [songs[from], songs[to]] = [songs[to], songs[from]];
    this.save(playlistId);
  }

  moveSongTo(playlistId: string, songId: string, targetId: string): void {
    const songs = this.requirePlaylist(playlistId).songs;
    const from = songs.findIndex(song => song.id === songId);
    const target = songs.findIndex(song => song.id === targetId);
    if (from < 0 || target < 0 || from === target) return;
    const [song] = songs.splice(from, 1);
    songs.splice(target, 0, song);
    this.save(playlistId);
  }

  deletePlaylist(playlistId: string): void {
    this.reload();
    this.playlists = this.playlists.filter(playlist => playlist.id !== playlistId);
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(this.playlists));
    this.changeListener?.({ type: 'delete', id: playlistId, deletedAt: new Date().toISOString() });
  }

  sortPlaylist(playlistId: string): void {
    this.requirePlaylist(playlistId).songs.sort((a, b) =>
      a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    this.save(playlistId);
  }

  private requirePlaylist(id: string): Playlist {
    // Another tab may have changed the library since this page loaded. Always
    // mutate the freshest saved copy so one window cannot overwrite another.
    this.reload();
    const playlist = this.getPlaylist(id); if (!playlist) throw new Error('Playlist not found.'); return playlist;
  }
  private save(playlistId: string): void {
    const playlist = this.playlists.find(item => item.id === playlistId);
    if (playlist) playlist.updatedAt = new Date().toISOString();
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(this.playlists));
    if (playlist) this.changeListener?.({ type: 'upsert', playlist: { ...playlist, songs: playlist.songs.map(song => ({ ...song })) } });
  }
}
