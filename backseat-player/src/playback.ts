import { useSyncExternalStore } from 'react';
import { PlayerEngine } from './player/engine';
import { bandwidth } from './player/net';
import type { RemoteFile, SourceSpec } from './player/types';
import { history } from './lib/history';
import { settings, type QualityPref } from './lib/settings';
import { createStore } from './lib/store';
import type { VideoItem } from './youtube/dataApi';
import {
  candidates,
  markGood,
  resolveAll,
  resolveFrom,
  ResolveError,
  type ResolvedStreams,
  type StreamFormat,
} from './youtube/streams';

export interface NowPlaying {
  id: string;
  kind: 'youtube' | 'direct';
  title: string;
  channel?: string;
  thumbnail?: string;
  durationSec?: number;
}

export interface PlaybackState {
  item: NowPlaying | null;
  /** Progress text while resolving/opening. */
  status: string | null;
  error: string | null;
  errorDetails: string[];
  /** Available adaptive heights, highest first. */
  heights: number[];
  currentHeight: number | null;
  sourceHost: string | null;
  mode: 'adaptive' | 'muxed' | null;
}

const initial: PlaybackState = {
  item: null,
  status: null,
  error: null,
  errorDetails: [],
  heights: [],
  currentHeight: null,
  sourceHost: null,
  mode: null,
};

/** Auto mode never goes above this: it's a car screen on LTE. */
const AUTO_MAX_HEIGHT = 720;

export const engine = new PlayerEngine();
const store = createStore<PlaybackState>(initial);

const remote = (f: StreamFormat): RemoteFile => ({
  url: f.url,
  initRange: f.initRange,
  indexRange: f.indexRange,
  contentLength: f.contentLength,
});

function videoLadder(r: ResolvedStreams): StreamFormat[] {
  const avc = r.formats
    .filter((f) => f.kind === 'video' && f.container === 'mp4' && /^avc[13]/.test(f.codecs) && f.height)
    // Same height: prefer 30fps over 60fps (half the decode work).
    .sort((a, b) => b.height! - a.height! || (a.fps ?? 30) - (b.fps ?? 30));
  const seen = new Set<number>();
  return avc.filter((f) => !seen.has(f.height!) && seen.add(f.height!));
}

function pickAudio(r: ResolvedStreams): StreamFormat | undefined {
  const aac = r.formats.filter((f) => f.kind === 'audio' && f.container === 'mp4' && /^mp4a/.test(f.codecs));
  const pool = aac.some((f) => f.originalAudio !== false) ? aac.filter((f) => f.originalAudio !== false) : aac;
  // itag 140 (AAC-LC 128k) is the sweet spot; avoid HE-AAC when LC exists.
  return pool.find((f) => f.itag === 140) ?? pool.find((f) => f.codecs === 'mp4a.40.2') ?? pool[0];
}

function pickMuxed(r: ResolvedStreams): StreamFormat | undefined {
  return r.formats.find((f) => f.kind === 'muxed' && f.container === 'mp4' && /avc1/.test(f.codecs));
}

function pickVideo(ladder: StreamFormat[], target: number): StreamFormat | undefined {
  return ladder.find((f) => f.height! <= target) ?? ladder[ladder.length - 1];
}

const targetHeight = (q: QualityPref, autoHeight: number) => (q === 'auto' ? autoHeight : q);

class PlaybackController {
  private token = 0;
  private abort: AbortController | null = null;
  private resolved: ResolvedStreams | null = null;
  private video: StreamFormat | null = null;
  private audio: StreamFormat | null = null;
  private autoHeight = AUTO_MAX_HEIGHT;
  private lastSwitch = 0;
  private lastStall = 0;

  constructor() {
    engine.onQualityHint = () => this.onQualityHint();
    engine.onEnded = () => {
      const it = store.get().item;
      if (it?.kind === 'youtube') history.savePosition(it.id, 0, 0);
    };
    setInterval(() => this.tick(), 5000);
    engine.bufferTargetUs = settings.get().bufferAhead * 1e6;
    engine.setVolume(settings.get().volume);
    settings.subscribe(() => {
      engine.bufferTargetUs = settings.get().bufferAhead * 1e6;
    });
  }

  get state() {
    return store.get();
  }

  async playYouTube(meta: Partial<VideoItem> & { id: string }, start?: number) {
    this.saveProgress();
    const tok = ++this.token;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    engine.unload();

    const item: NowPlaying = {
      id: meta.id,
      kind: 'youtube',
      title: meta.title ?? 'Loading…',
      channel: meta.channel,
      thumbnail: meta.thumbnail ?? `https://i.ytimg.com/vi/${meta.id}/hqdefault.jpg`,
      durationSec: meta.durationSec,
    };
    store.set({ ...initial, item, status: 'Finding stream…' });
    const startAt = start ?? history.resumePosition(meta.id);
    const errors: string[] = [];

    try {
      for await (const r of resolveAll(meta.id, abort.signal, (msg) => this.patch(tok, { status: msg }))) {
        if (tok !== this.token) return;
        if (item.title === 'Loading…' && r.title) item.title = r.title;
        item.channel ??= r.author;
        item.durationSec ??= r.durationSec;
        history.touch({
          id: item.id,
          title: item.title,
          channel: item.channel,
          thumbnail: item.thumbnail,
          durationSec: item.durationSec,
        });
        const host = new URL(r.instance).host;
        for (const plan of this.plans(r)) {
          this.patch(tok, { item: { ...item }, status: `Loading ${plan.label} from ${host}…` });
          try {
            await engine.load(plan.spec, { startTime: startAt, autoplay: true, refresh: () => this.refresh(tok) });
            if (tok !== this.token) return;
            this.resolved = r;
            this.video = plan.video ?? null;
            this.audio = plan.audio ?? null;
            markGood(r.instance);
            this.patch(tok, {
              item: { ...item },
              status: null,
              heights: videoLadder(r).map((f) => f.height!),
              currentHeight: plan.video?.height ?? plan.muxedHeight ?? null,
              sourceHost: host,
              mode: plan.spec.type === 'adaptive' ? 'adaptive' : 'muxed',
            });
            return;
          } catch (e) {
            if (tok !== this.token) return;
            errors.push(`${host} (${plan.label}): ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      if (tok !== this.token) return;
      if (e instanceof ResolveError) errors.unshift(...e.attempts);
      else errors.push((e as Error).message);
    }
    if (tok !== this.token) return;
    this.patch(tok, {
      status: null,
      error: errors.length ? "Couldn't play this video." : 'Playback cancelled.',
      errorDetails: errors,
    });
  }

  async playDirect(url: string) {
    this.saveProgress();
    const tok = ++this.token;
    this.abort?.abort();
    engine.unload();
    const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'Video');
    store.set({ ...initial, item: { id: url, kind: 'direct', title: name }, status: 'Loading…' });
    try {
      await engine.load({ type: 'muxed', file: { url } }, { autoplay: true });
      if (tok !== this.token) return;
      this.patch(tok, { status: null, mode: 'muxed', sourceHost: new URL(url, location.href).host });
    } catch (e) {
      if (tok !== this.token) return;
      this.patch(tok, { status: null, error: "Couldn't play this file.", errorDetails: [(e as Error).message] });
    }
  }

  /** Full retry from the current position, re-resolving every source. */
  retry() {
    const s = store.get();
    if (!s.item) return;
    const pos = engine.hasMedia ? engine.currentTime : undefined;
    if (s.item.kind === 'direct') return this.playDirect(s.item.id);
    return this.playYouTube(
      { id: s.item.id, title: s.item.title, channel: s.item.channel, thumbnail: s.item.thumbnail, durationSec: s.item.durationSec },
      pos,
    );
  }

  close() {
    this.saveProgress();
    this.token++;
    this.abort?.abort();
    engine.unload();
    this.resolved = null;
    store.set(initial);
  }

  async setQuality(q: QualityPref) {
    settings.update({ quality: q });
    if (q === 'auto') this.autoHeight = AUTO_MAX_HEIGHT;
    const r = this.resolved;
    if (!r || store.get().mode !== 'adaptive') return this.retry();
    const next = pickVideo(videoLadder(r), targetHeight(q, this.autoHeight));
    if (next) await this.switchTo(next);
  }

  // ------------------------------------------------------------------------

  private plans(r: ResolvedStreams) {
    const out: {
      label: string;
      spec: SourceSpec;
      video?: StreamFormat;
      audio?: StreamFormat;
      muxedHeight?: number;
    }[] = [];
    const ladder = videoLadder(r);
    const audio = pickAudio(r);
    const v = pickVideo(ladder, targetHeight(settings.get().quality, this.autoHeight));
    if (v && audio) {
      out.push({ label: `${v.height}p`, spec: { type: 'adaptive', video: remote(v), audio: remote(audio) }, video: v, audio });
    }
    const muxed = pickMuxed(r);
    if (muxed) {
      out.push({ label: `${muxed.height ?? 360}p (compat)`, spec: { type: 'muxed', file: remote(muxed) }, muxedHeight: muxed.height });
    }
    return out;
  }

  private async refresh(tok: number): Promise<SourceSpec> {
    const id = store.get().item?.id;
    const prev = this.resolved;
    if (!id || !prev) throw new Error('nothing to refresh');
    const order = candidates().sort((a, b) => (a.base === prev.instance ? -1 : b.base === prev.instance ? 1 : 0));
    for (const c of order) {
      if (tok !== this.token) break;
      try {
        const r = await resolveFrom(c, id);
        if (store.get().mode === 'muxed') {
          const m = pickMuxed(r);
          if (!m) continue;
          this.resolved = r;
          return { type: 'muxed', file: remote(m) };
        }
        const v = r.formats.find((f) => f.kind === 'video' && f.itag === this.video?.itag);
        const a = r.formats.find((f) => f.kind === 'audio' && f.itag === this.audio?.itag);
        if (!v || (this.audio && !a)) continue;
        this.resolved = r;
        this.video = v;
        this.audio = a ?? null;
        this.patch(tok, { sourceHost: new URL(r.instance).host });
        return { type: 'adaptive', video: remote(v), audio: a ? remote(a) : undefined };
      } catch {
        /* try next instance */
      }
    }
    throw new Error('refresh failed');
  }

  private async switchTo(f: StreamFormat) {
    if (f.itag === this.video?.itag) return;
    const tok = this.token;
    this.lastSwitch = performance.now();
    try {
      await engine.switchVideo(remote(f));
      if (tok !== this.token) return;
      this.video = f;
      this.patch(tok, { currentHeight: f.height ?? null });
    } catch {
      /* keep the current rendition */
    }
  }

  private onQualityHint() {
    this.lastStall = performance.now();
    if (settings.get().quality !== 'auto' || store.get().mode !== 'adaptive' || !this.resolved) return;
    if (performance.now() - this.lastSwitch < 20_000) return;
    const ladder = videoLadder(this.resolved);
    const cur = this.video?.height ?? AUTO_MAX_HEIGHT;
    const lower = ladder.find((f) => f.height! < cur);
    if (!lower) return;
    this.autoHeight = lower.height!;
    void this.switchTo(lower);
  }

  private tick() {
    this.saveProgress();
    // Cautious step-up in auto mode after a calm period.
    const s = store.get();
    if (settings.get().quality !== 'auto' || s.mode !== 'adaptive' || !this.resolved || !this.video) return;
    const now = performance.now();
    if (now - this.lastStall < 90_000 || now - this.lastSwitch < 60_000) return;
    const snap = engine.getSnapshot();
    if (snap.state !== 'playing' || snap.bufferedAhead < 30) return;
    const higher = videoLadder(this.resolved)
      .filter((f) => f.height! > this.video!.height! && f.height! <= AUTO_MAX_HEIGHT)
      .pop();
    if (!higher) return;
    if (bandwidth.bitsPerSecond > 2.5 * (higher.bitrate ?? 2_500_000)) {
      this.autoHeight = higher.height!;
      void this.switchTo(higher);
    }
  }

  private saveProgress() {
    const it = store.get().item;
    if (!it || it.kind !== 'youtube' || !engine.hasMedia) return;
    const snap = engine.getSnapshot();
    if (snap.duration > 0) history.savePosition(it.id, engine.currentTime, snap.duration);
  }

  private patch(tok: number, p: Partial<PlaybackState>) {
    if (tok !== this.token) return;
    store.set((s) => ({ ...s, ...p }));
  }
}

export const playback = new PlaybackController();

export function usePlayback(): PlaybackState {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function usePlayerSnapshot() {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}

if (import.meta.env.DEV) {
  // Debug handle for local testing (stripped from production builds).
  (window as unknown as Record<string, unknown>).__backseat = { engine, playback, store };
}
