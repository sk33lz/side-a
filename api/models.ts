export type SongSource = 'YouTube' | 'Spotify' | 'SoundCloud' | 'Apple Music' | 'Tidal';

export interface Song {
  id: string;
  title: string;
  artist: string;
  source: SongSource;
  url: string;
  addedAt: string;
  artworkUrl?: string;
  embedUrl?: string;
}

export interface Playlist {
  id: string;
  name: string;
  songs: Song[];
  createdAt: string;
}

export interface SharedPlaylist {
  id: string;
  playlist: Playlist;
  updatedAt: string;
}
