import type { Song, SongSource } from './models';

const sources: Array<{ source: SongSource; hosts: string[] }> = [
  { source: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { source: 'Spotify', hosts: ['spotify.com'] },
  { source: 'SoundCloud', hosts: ['soundcloud.com'] },
  { source: 'Apple Music', hosts: ['music.apple.com'] },
  { source: 'Tidal', hosts: ['tidal.com'] },
];

function matchesHost(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

export class LinkIngestionService {
  async ingestSongFromLink(input: string): Promise<Song> {
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      throw new Error('Enter a complete link starting with https://.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Use an http or https link.');
    const match = sources.find(({ hosts }) => hosts.some(host => matchesHost(url.hostname.toLowerCase(), host)));
    if (!match) throw new Error('That link is not from YouTube, Spotify, SoundCloud, Apple Music, or Tidal.');
    let title = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    try { title = decodeURIComponent(title); } catch { /* Keep the original URL segment. */ }
    title = title.replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim();
    const song: Song = {
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: title && !/^track$|^album$|^playlist$|^watch$/i.test(title) ? title : 'Untitled track',
      artist: '', source: match.source, url: url.href, addedAt: new Date().toISOString(),
    };
    song.embedUrl = this.getEmbedUrl(url, match.source);
    try {
      const metadata = await this.fetchMetadata(url, match.source);
      if (metadata.title) song.title = metadata.title;
      if (metadata.artist) song.artist = metadata.artist;
      if (metadata.artworkUrl) song.artworkUrl = metadata.artworkUrl;
    } catch {
      // Preserve the link-derived fallback if a provider has no public metadata or blocks browser requests.
    }
    return song;
  }

  getEmbedUrl(url: URL, source: SongSource): string | undefined {
    if (source === 'YouTube') {
      const id = url.hostname === 'youtu.be' ? url.pathname.split('/').filter(Boolean)[0] :
        url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.split('/').filter(Boolean).at(-1);
      return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : undefined;
    }
    if (source === 'Spotify') {
      const match = url.pathname.match(/^\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)\/?$/);
      return match ? `https://open.spotify.com/embed/${match[1]}/${match[2]}` : undefined;
    }
    if (source === 'SoundCloud') {
      const player = new URL('https://w.soundcloud.com/player/');
      player.searchParams.set('url', url.href);
      player.searchParams.set('color', '%23536c46');
      player.searchParams.set('auto_play', 'false');
      player.searchParams.set('visual', 'true');
      return player.href;
    }
    if (source === 'Apple Music' && /^\/(\w{2})\/(album|playlist|song)\//.test(url.pathname)) {
      url.hostname = 'embed.music.apple.com';
      return url.href;
    }
    return undefined;
  }

  private async fetchMetadata(url: URL, source: SongSource): Promise<{ title?: string; artist?: string; artworkUrl?: string }> {
    if (!['YouTube', 'Spotify', 'SoundCloud'].includes(source)) return {};
    const endpoint = source === 'YouTube'
      ? 'https://www.youtube.com/oembed'
      : source === 'Spotify'
        ? 'https://open.spotify.com/oembed'
        : 'https://soundcloud.com/oembed';
    const requestUrl = new URL(endpoint);
    requestUrl.searchParams.set('url', url.href);
    requestUrl.searchParams.set('format', 'json');
    const response = await fetch(requestUrl, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return {};
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') return {};
    const result = data as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown };
    if (typeof result.title !== 'string') return {};
    if (source === 'SoundCloud') {
      const match = result.title.match(/^(.*)\s+by\s+(.+)$/i);
      if (match) return {
        title: match[1].trim(), artist: match[2].trim(),
        artworkUrl: typeof result.thumbnail_url === 'string' ? result.thumbnail_url : undefined,
      };
    }
    return {
      title: result.title.trim(),
      artist: typeof result.author_name === 'string' ? result.author_name.trim() : undefined,
      artworkUrl: typeof result.thumbnail_url === 'string' ? result.thumbnail_url : undefined,
    };
  }
}
