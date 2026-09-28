import type { Playlist, Song } from './models';

const STORAGE_KEY = 'side-a.playlists.v1';
const createId = (): string => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function readPlaylists(): Playlist[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Playlist => item && typeof item.id === 'string' &&
      typeof item.name === 'string' && Array.isArray(item.songs));
  } catch { return []; }
}

export class PlaylistManager {
  private playlists = readPlaylists();
  listPlaylists(): Playlist[] { return this.playlists; }
  getPlaylist(id: string): Playlist | undefined { return this.playlists.find(playlist => playlist.id === id); }

  createPlaylist(name: string): Playlist {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('Give your playlist a name first.');
    if (cleanName.length > 60) throw new Error('Playlist names can be up to 60 characters.');
    const playlist: Playlist = { id: createId(), name: cleanName, songs: [], createdAt: new Date().toISOString() };
    this.playlists.unshift(playlist); this.save(); return playlist;
  }

  addSong(playlistId: string, song: Song): void { this.requirePlaylist(playlistId).songs.push(song); this.save(); }

  updateSong(playlistId: string, songId: string, updates: Pick<Song, 'title' | 'artist'>): void {
    const song = this.requirePlaylist(playlistId).songs.find(item => item.id === songId);
    if (!song) throw new Error('That track is no longer in this playlist.');
    song.title = updates.title.trim() || 'Untitled track'; song.artist = updates.artist.trim(); this.save();
  }

  removeSong(playlistId: string, songId: string): void {
    const playlist = this.requirePlaylist(playlistId); playlist.songs = playlist.songs.filter(song => song.id !== songId); this.save();
  }

  moveSong(playlistId: string, songId: string, offset: -1 | 1): void {
    const songs = this.requirePlaylist(playlistId).songs;
    const from = songs.findIndex(song => song.id === songId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= songs.length) return;
    [songs[from], songs[to]] = [songs[to], songs[from]];
    this.save();
  }

  deletePlaylist(playlistId: string): void { this.playlists = this.playlists.filter(playlist => playlist.id !== playlistId); this.save(); }

  sortPlaylist(playlistId: string): void {
    this.requirePlaylist(playlistId).songs.sort((a, b) =>
      a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    this.save();
  }

  private requirePlaylist(id: string): Playlist {
    const playlist = this.getPlaylist(id); if (!playlist) throw new Error('Playlist not found.'); return playlist;
  }
  private save(): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.playlists)); }
}
