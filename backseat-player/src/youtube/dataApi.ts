import { parseIsoDuration } from '../lib/format';
import { settings } from '../lib/settings';

/**
 * YouTube Data API v3. Quota math (default 10,000 units/day):
 *   search.list = 100 units, videos.list = 1 unit.
 * So ~95 searches/day. Results are cached for 30 min to stretch that.
 */

export interface VideoItem {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  durationSec?: number;
  views?: number;
  publishedAt?: string;
  live?: boolean;
}

export interface SearchPage {
  items: VideoItem[];
  nextPageToken?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

const BASE = 'https://www.googleapis.com/youtube/v3';
const TTL = 30 * 60 * 1000;
const cache = new Map<string, { at: number; data: unknown }>();

async function call<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const key = settings.apiKey();
  if (!key) throw new ApiError('No YouTube API key set. Add one in Settings or VITE_YOUTUBE_API_KEY.', 'noKey');
  const qs = new URLSearchParams({ ...params, key });
  const cacheKey = `${endpoint}?${new URLSearchParams(params)}`;
  const hit = cache.get(cacheKey) ?? sessionGet(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.data as T;

  const res = await fetch(`${BASE}/${endpoint}?${qs}`, { referrerPolicy: 'strict-origin-when-cross-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason: string | undefined = body?.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new ApiError('Daily YouTube API quota used up. Paste a link to play, or try tomorrow.', reason);
    }
    if (reason === 'keyInvalid' || res.status === 400) {
      throw new ApiError('YouTube API key is invalid. Check Settings.', reason);
    }
    if (res.status === 403) {
      throw new ApiError(body?.error?.message || 'YouTube API refused the request (check key restrictions).', reason);
    }
    throw new ApiError(body?.error?.message || `YouTube API error ${res.status}`, reason);
  }
  const entry = { at: Date.now(), data: body };
  cache.set(cacheKey, entry);
  sessionSet(cacheKey, entry);
  return body as T;
}

function sessionGet(k: string): { at: number; data: unknown } | undefined {
  try {
    const raw = sessionStorage.getItem(`yt:${k}`);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function sessionSet(k: string, v: unknown) {
  try {
    sessionStorage.setItem(`yt:${k}`, JSON.stringify(v));
  } catch {
    /* ignore quota errors */
  }
}

interface ApiThumbs {
  [k: string]: { url: string } | undefined;
}

interface ApiVideo {
  id: string;
  snippet: {
    title: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails: ApiThumbs;
    liveBroadcastContent?: string;
  };
  contentDetails?: { duration: string };
  statistics?: { viewCount?: string };
}

const pickThumb = (t: ApiThumbs) => t.maxres?.url ?? t.high?.url ?? t.medium?.url ?? t.default?.url ?? '';

function toItem(v: ApiVideo): VideoItem {
  return {
    id: v.id,
    title: decodeEntities(v.snippet.title),
    channel: v.snippet.channelTitle,
    thumbnail: pickThumb(v.snippet.thumbnails),
    durationSec: parseIsoDuration(v.contentDetails?.duration),
    views: v.statistics?.viewCount ? Number(v.statistics.viewCount) : undefined,
    publishedAt: v.snippet.publishedAt,
    live: v.snippet.liveBroadcastContent === 'live' || v.snippet.liveBroadcastContent === 'upcoming',
  };
}

function decodeEntities(s: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

export async function getVideos(ids: string[]): Promise<VideoItem[]> {
  if (!ids.length) return [];
  const data = await call<{ items: ApiVideo[] }>('videos', {
    part: 'snippet,contentDetails,statistics',
    id: ids.join(','),
    maxResults: '50',
  });
  const byId = new Map(data.items.map((v) => [v.id, toItem(v)]));
  return ids.map((id) => byId.get(id)).filter((v): v is VideoItem => !!v);
}

export async function searchVideos(q: string, pageToken?: string): Promise<SearchPage> {
  const params: Record<string, string> = {
    part: 'snippet',
    type: 'video',
    q,
    maxResults: '24',
    safeSearch: 'none',
  };
  if (pageToken) params.pageToken = pageToken;
  const data = await call<{ items: { id: { videoId: string } }[]; nextPageToken?: string }>('search', params);
  const ids = data.items.map((i) => i.id.videoId).filter(Boolean);
  // Second call (1 unit) adds durations + view counts and filters out live.
  const items = (await getVideos(ids)).filter((v) => !v.live);
  return { items, nextPageToken: data.nextPageToken };
}

export async function trending(pageToken?: string): Promise<SearchPage> {
  const params: Record<string, string> = {
    part: 'snippet,contentDetails,statistics',
    chart: 'mostPopular',
    regionCode: settings.get().region || 'US',
    maxResults: '24',
  };
  if (pageToken) params.pageToken = pageToken;
  const data = await call<{ items: ApiVideo[]; nextPageToken?: string }>('videos', params);
  return { items: data.items.map(toItem).filter((v) => !v.live), nextPageToken: data.nextPageToken };
}
