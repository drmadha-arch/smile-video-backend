import { settings } from '../lib/settings';
import { readJSON, writeJSON } from '../lib/store';

/**
 * Stream URL resolution via Invidious / Piped.
 *
 * The browser can't fetch googlevideo.com directly (no CORS, IP-locked URLs,
 * signature ciphers), so we need an instance that both extracts the URLs and
 * proxies the bytes with CORS headers:
 *   - Invidious with `local=true`  -> /videoplayback on the instance
 *   - Piped                         -> its pipedproxy host
 * Instances are tried in order; the last one that worked is tried first.
 */

export interface StreamFormat {
  kind: 'video' | 'audio' | 'muxed';
  url: string;
  itag: number;
  codecs: string;
  container: 'mp4' | 'webm' | 'other';
  height?: number;
  fps?: number;
  bitrate?: number;
  contentLength?: number;
  initRange?: [number, number];
  indexRange?: [number, number];
  /** False for dubbed / secondary audio tracks. */
  originalAudio?: boolean;
}

export interface ResolvedStreams {
  provider: 'invidious' | 'piped';
  instance: string;
  title?: string;
  author?: string;
  durationSec?: number;
  live: boolean;
  formats: StreamFormat[];
}

export class ResolveError extends Error {
  constructor(
    message: string,
    public attempts: string[] = [],
  ) {
    super(message);
  }
}

const LAST_GOOD = 'backseat.lastGoodInstance';

interface Candidate {
  provider: 'invidious' | 'piped';
  base: string;
}

export function candidates(): Candidate[] {
  const s = settings.get();
  const all: Candidate[] = [
    ...s.invidious.map((base) => ({ provider: 'invidious' as const, base })),
    ...s.piped.map((base) => ({ provider: 'piped' as const, base })),
  ];
  const last = readJSON<string | null>(LAST_GOOD, null);
  const i = all.findIndex((c) => c.base === last);
  if (i > 0) all.unshift(...all.splice(i, 1));
  return all;
}

export function markGood(base: string) {
  writeJSON(LAST_GOOD, base);
}

async function getJSON(url: string, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || body?.message || `HTTP ${res.status}`);
    if (!body) throw new Error('Empty response');
    if (body.error) throw new Error(String(body.error));
    return body;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

const parseRange = (r?: string): [number, number] | undefined => {
  const m = /^(\d+)-(\d+)$/.exec(r ?? '');
  return m ? [Number(m[1]), Number(m[2])] : undefined;
};

const containerOf = (mime: string): StreamFormat['container'] =>
  /mp4/i.test(mime) ? 'mp4' : /webm/i.test(mime) ? 'webm' : 'other';

const codecsOf = (type: string) => /codecs="([^"]+)"/.exec(type)?.[1] ?? '';

function rejectDirectGooglevideo(url: string) {
  // A googlevideo URL means the instance isn't proxying: it won't work from a browser.
  if (/googlevideo\.com/i.test(new URL(url).hostname)) {
    throw new Error('Instance does not proxy video (local=true disabled)');
  }
}

async function fromInvidious(base: string, id: string, signal?: AbortSignal): Promise<ResolvedStreams> {
  const j = await getJSON(`${base}/api/v1/videos/${id}?local=true`, 10_000, signal);
  const abs = (u: string) => new URL(u, base).toString();
  const formats: StreamFormat[] = [];
  for (const f of j.adaptiveFormats ?? []) {
    if (!f.url) continue;
    const isVideo = /^video\//.test(f.type ?? '');
    formats.push({
      kind: isVideo ? 'video' : 'audio',
      url: abs(f.url),
      itag: Number(f.itag),
      codecs: codecsOf(f.type ?? ''),
      container: containerOf(f.type ?? ''),
      height: isVideo ? Number(/^(\d+)p/.exec(f.qualityLabel ?? f.resolution ?? '')?.[1] ?? 0) || undefined : undefined,
      fps: f.fps ? Number(f.fps) : undefined,
      bitrate: f.bitrate ? Number(f.bitrate) : undefined,
      contentLength: f.clen ? Number(f.clen) : undefined,
      initRange: parseRange(f.init),
      indexRange: parseRange(f.index),
      originalAudio: f.audioTrack ? !!f.audioTrack.isDefault || /original/i.test(f.audioTrack.displayName ?? '') : true,
    });
  }
  for (const f of j.formatStreams ?? []) {
    if (!f.url) continue;
    formats.push({
      kind: 'muxed',
      url: abs(f.url),
      itag: Number(f.itag),
      codecs: codecsOf(f.type ?? ''),
      container: containerOf(f.type ?? ''),
      height: Number(/(\d+)p/.exec(f.resolution ?? f.qualityLabel ?? '')?.[1] ?? 0) || undefined,
    });
  }
  if (!formats.length) throw new Error(j.liveNow ? 'Live streams are not supported' : 'No playable formats');
  rejectDirectGooglevideo(formats[0].url);
  return {
    provider: 'invidious',
    instance: base,
    title: j.title,
    author: j.author,
    durationSec: j.lengthSeconds,
    live: !!j.liveNow,
    formats,
  };
}

async function fromPiped(base: string, id: string, signal?: AbortSignal): Promise<ResolvedStreams> {
  const j = await getJSON(`${base}/streams/${id}`, 10_000, signal);
  const formats: StreamFormat[] = [];
  const range = (s?: number, e?: number): [number, number] | undefined =>
    s !== undefined && e !== undefined && e > 0 ? [s, e] : undefined;
  for (const f of j.videoStreams ?? []) {
    if (!f.url) continue;
    formats.push({
      kind: f.videoOnly ? 'video' : 'muxed',
      url: f.url,
      itag: Number(f.itag),
      codecs: f.codec ?? '',
      container: containerOf(f.mimeType ?? ''),
      height: f.height || Number(/(\d+)p/.exec(f.quality ?? '')?.[1] ?? 0) || undefined,
      fps: f.fps,
      bitrate: f.bitrate,
      contentLength: f.contentLength > 0 ? f.contentLength : undefined,
      initRange: range(f.initStart, f.initEnd),
      indexRange: range(f.indexStart, f.indexEnd),
    });
  }
  for (const f of j.audioStreams ?? []) {
    if (!f.url) continue;
    formats.push({
      kind: 'audio',
      url: f.url,
      itag: Number(f.itag),
      codecs: f.codec ?? '',
      container: containerOf(f.mimeType ?? ''),
      bitrate: f.bitrate,
      contentLength: f.contentLength > 0 ? f.contentLength : undefined,
      initRange: range(f.initStart, f.initEnd),
      indexRange: range(f.indexStart, f.indexEnd),
      originalAudio: !f.audioTrackType || f.audioTrackType === 'ORIGINAL',
    });
  }
  if (!formats.length) throw new Error(j.livestream ? 'Live streams are not supported' : 'No playable formats');
  rejectDirectGooglevideo(formats[0].url);
  return {
    provider: 'piped',
    instance: base,
    title: j.title,
    author: j.uploader,
    durationSec: j.duration,
    live: !!j.livestream,
    formats,
  };
}

export function resolveFrom(c: Candidate, id: string, signal?: AbortSignal): Promise<ResolvedStreams> {
  return c.provider === 'invidious' ? fromInvidious(c.base, id, signal) : fromPiped(c.base, id, signal);
}

/** Yields resolved streams from each working instance, in priority order. */
export async function* resolveAll(
  id: string,
  signal?: AbortSignal,
  onAttempt?: (msg: string) => void,
): AsyncGenerator<ResolvedStreams> {
  const list = candidates();
  if (!list.length) throw new ResolveError('No Invidious/Piped instances configured. Add one in Settings.');
  const errors: string[] = [];
  for (const c of list) {
    if (signal?.aborted) return;
    onAttempt?.(`Finding stream via ${new URL(c.base).host}…`);
    try {
      const r = await resolveFrom(c, id, signal);
      if (r.live) throw new Error('Live streams are not supported');
      yield r;
    } catch (e) {
      if (signal?.aborted) return;
      errors.push(`${new URL(c.base).host}: ${(e as Error).message}`);
    }
  }
  throw new ResolveError('No stream source worked for this video.', errors);
}

/** Lightweight health check for the Settings screen. */
export async function pingInstance(provider: 'invidious' | 'piped', base: string): Promise<number> {
  const t0 = performance.now();
  // A short, always-available video makes a realistic end-to-end check.
  const probeId = 'jNQXAC9IVRw';
  await resolveFrom({ provider, base }, probeId);
  return Math.round(performance.now() - t0);
}
