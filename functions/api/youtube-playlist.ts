import type { Song } from '../../api/models';

interface Env { GOOGLE_API_KEY: string }

interface PlaylistItemResponse {
  items?: Array<{ contentDetails?: { videoId?: string } }>;
  nextPageToken?: string;
  pageInfo?: { totalResults?: number };
  error?: { message?: string };
}

interface VideoResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      channelTitle?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
    contentDetails?: { duration?: string };
  }>;
  error?: { message?: string };
}

interface PlaylistResponse {
  items?: Array<{ snippet?: { title?: string } }>;
}

const MAX_TRACKS = 500;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': status === 200 ? 'private, max-age=300' : 'no-store' },
  });
}

function playlistId(input: string): string | null {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    if (!(hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be')) return null;
    const id = url.searchParams.get('list');
    return id && /^[a-zA-Z0-9_-]{10,100}$/.test(id) ? id : null;
  } catch { return null; }
}

function isoDurationSeconds(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return undefined;
  const seconds = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  return seconds > 0 ? seconds : undefined;
}

function bestThumbnail(thumbnails?: Record<string, { url?: string }>): string | undefined {
  if (!thumbnails) return undefined;
  for (const name of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = thumbnails[name]?.url;
    if (url?.startsWith('https://')) return url;
  }
  return undefined;
}

async function youtube<T>(path: string, params: Record<string, string>, key: string, referer: string): Promise<T> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));
  url.searchParams.set('key', key);
  // Google checks this header when an API key is restricted to the app's
  // website. The key itself remains server-side in the Pages secret.
  const response = await fetch(url, {
    headers: { Referer: referer },
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message ?? 'YouTube did not return playlist data.');
  return data;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.GOOGLE_API_KEY) return json({ error: 'YouTube playlist importing is not configured.' }, 503);
  const id = playlistId(new URL(request.url).searchParams.get('url') ?? '');
  if (!id) return json({ error: 'Paste a valid YouTube playlist URL.' }, 400);

  try {
    const referer = `${new URL(request.url).origin}/`;
    const videoIds: string[] = [];
    let pageToken = '';
    let totalResults = 0;
    do {
      const page = await youtube<PlaylistItemResponse>('playlistItems', {
        part: 'contentDetails', playlistId: id, maxResults: '50', ...(pageToken ? { pageToken } : {}),
      }, env.GOOGLE_API_KEY, referer);
      totalResults = page.pageInfo?.totalResults ?? totalResults;
      for (const item of page.items ?? []) {
        const videoId = item.contentDetails?.videoId;
        if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) videoIds.push(videoId);
        if (videoIds.length >= MAX_TRACKS) break;
      }
      pageToken = videoIds.length < MAX_TRACKS ? page.nextPageToken ?? '' : '';
    } while (pageToken);

    if (!videoIds.length) return json({ error: 'This playlist has no public videos to import.' }, 404);

    const details = new Map<string, NonNullable<VideoResponse['items']>[number]>();
    for (let index = 0; index < videoIds.length; index += 50) {
      const batch = await youtube<VideoResponse>('videos', {
        part: 'snippet,contentDetails', id: videoIds.slice(index, index + 50).join(','), maxResults: '50',
      }, env.GOOGLE_API_KEY, referer);
      for (const video of batch.items ?? []) if (video.id) details.set(video.id, video);
    }

    const addedAt = new Date().toISOString();
    const songs: Song[] = videoIds.flatMap(videoId => {
      const video = details.get(videoId);
      const title = video?.snippet?.title?.trim();
      if (!video || !title) return [];
      return [{
        id: crypto.randomUUID(),
        title,
        artist: video.snippet?.channelTitle?.trim() ?? '',
        source: 'YouTube',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        artworkUrl: bestThumbnail(video.snippet?.thumbnails),
        durationSeconds: isoDurationSeconds(video.contentDetails?.duration),
        addedAt,
      } satisfies Song];
    });

    if (!songs.length) return json({ error: 'This playlist has no public videos available to import.' }, 404);

    const playlist = await youtube<PlaylistResponse>('playlists', { part: 'snippet', id }, env.GOOGLE_API_KEY, referer);
    const title = playlist.items?.[0]?.snippet?.title?.trim();
    return json({ songs, title, truncated: totalResults > MAX_TRACKS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The YouTube playlist could not be imported.';
    console.error('YouTube playlist import failed:', message);
    // Cloudflare replaces 5xx bodies on custom domains. A dependency error is
    // returned as 424 so the app can show Google's useful explanation.
    return json({ error: message }, 424);
  }
};
