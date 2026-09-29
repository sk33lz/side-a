export type SongSource = 'YouTube' | 'Spotify' | 'SoundCloud' | 'Apple Music' | 'Tidal';
export type PlaylistTheme = 'side-a' | 'mixtape' | 'cd-mix' | 'playlist';

export interface Song {
  id: string;
  title: string;
  artist: string;
  source: SongSource;
  url: string;
  addedAt: string;
  artworkUrl?: string;
  embedUrl?: string;
  durationSeconds?: number;
}

export interface Playlist {
  id: string;
  name: string;
  songs: Song[];
  createdAt: string;
  theme?: PlaylistTheme;
  recipient?: string;
  sender?: string;
  dedication?: string;
  feedbackShareId?: string;
}

export interface SharedPlaylist {
  id: string;
  playlist: Playlist;
  updatedAt: string;
}
