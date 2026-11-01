import { bandwidth } from './net';
import { AudioPipeline, VideoPipeline, type AudioHost } from './pipelines';
import { openSource, openVideoFile } from './tracks';
import type { LoadOptions, PlayerSnapshot, PlayerState, RemoteFile, SourceSpec } from './types';

/**
 * Canvas + WebCodecs player.
 *
 * Why not <video>: Tesla's browser blocks <video> playback once the car leaves
 * Park. Pixels drawn to a <canvas> and sound played through Web Audio are not
 * blocked, so we do the demuxing, decoding, A/V sync and buffering ourselves.
 *
 * Clock: the AudioContext is the master clock. Pausing and buffering suspend
 * the context, which freezes `currentTime` and every scheduled audio buffer at
 * once, so A/V can't drift apart across pauses or stalls.
 */
export class PlayerEngine implements AudioHost {
  bufferTargetUs = 60_000_000;
  /** Called when the engine thinks the current quality is too heavy. */
  onQualityHint?: (reason: 'stalls' | 'decoder') => void;
  onEnded?: () => void;

  private canvas: HTMLCanvasElement | null = null;
  private g2d: CanvasRenderingContext2D | null = null;
  private ro: ResizeObserver | null = null;
  private lastRect = '';

  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private video: VideoPipeline | null = null;
  private audio: AudioPipeline | null = null;
  private anchorCtx = 0;
  private anchorMedia = 0;

  private wantPlay = false;
  private buffering = true;
  private loading = false;
  private ended = false;
  private errorMsg: string | undefined;
  private message: string | undefined;
  private durationSec = 0;
  private resumeThresholdUs = 1_000_000;

  private loadGen = 0;
  private abort: AbortController | null = null;
  private refreshFn: LoadOptions['refresh'];
  private refreshing: Promise<boolean> | null = null;
  private lastRefreshOk = 0;
  private refreshStrikes = 0;

  private stallTimes: number[] = [];
  private stallCount = 0;
  private catchUpTimes: number[] = [];
  private autoplayCheck = 0;

  private raf = 0;
  private timer = 0;
  private listeners = new Set<() => void>();
  private lastEmit = 0;
  private snap: PlayerSnapshot;
  private volume = 1;
  private muted = false;

  constructor() {
    this.snap = this.buildSnapshot();
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // ------------------------------------------------------------ public ----

  attachCanvas(canvas: HTMLCanvasElement | null) {
    if (canvas === this.canvas) return;
    this.ro?.disconnect();
    this.canvas = canvas;
    this.g2d = canvas ? canvas.getContext('2d', { alpha: false }) : null;
    this.lastRect = '';
    if (canvas) {
      this.ro = new ResizeObserver(() => this.resizeCanvas());
      this.ro.observe(canvas);
      this.resizeCanvas();
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  /** Opens the source; throws if it can't be opened (caller may try another source). */
  async load(spec: SourceSpec, opts: LoadOptions = {}) {
    this.teardown();
    const gen = ++this.loadGen;
    this.abort = new AbortController();
    this.loading = true;
    this.buffering = true;
    this.ended = false;
    this.errorMsg = undefined;
    this.message = undefined;
    this.wantPlay = opts.autoplay ?? true;
    this.refreshFn = opts.refresh;
    this.refreshStrikes = 0;
    this.stallTimes = [];
    this.stallCount = 0;
    this.emit(true);

    try {
      const opened = await openSource(spec, this.abort.signal);
      if (gen !== this.loadGen) return;
      if (!opened.video) throw new Error('No video track');

      const video = new VideoPipeline(this, opened.video);
      video.hwPref = await pickHwPref(video.config());
      if (gen !== this.loadGen) return;
      if (opened.audio) {
        const support = await AudioDecoder.isConfigSupported(
          new AudioPipeline(this, opened.audio).config(),
        ).catch(() => ({ supported: false }));
        if (!support.supported) throw new Error(`Audio codec ${opened.audio.info.codec} not supported`);
      }

      this.setupAudio(opened.audio?.info.kind === 'audio' ? opened.audio.info.sampleRate : undefined);
      this.video = video;
      this.audio = opened.audio ? new AudioPipeline(this, opened.audio) : null;
      this.durationSec = opened.durationSec;
      const start = clamp(opts.startTime ?? 0, 0, Math.max(0, this.durationSec - 1));
      this.seekInternal(start);
      this.startLoop();
    } catch (e) {
      if (gen === this.loadGen) {
        this.loading = false;
        this.teardown();
        this.emit(true);
      }
      throw e;
    }
  }

  /** Swap the video rendition (quality change) without touching audio. */
  async switchVideo(file: RemoteFile) {
    if (!this.video || !this.abort) return;
    const gen = this.loadGen;
    const stream = await openVideoFile(file, this.abort.signal);
    if (gen !== this.loadGen || !this.video) return;
    const next = new VideoPipeline(this, stream);
    next.hwPref = await pickHwPref(next.config());
    if (gen !== this.loadGen || !this.video) return;
    const old = this.video;
    next.adoptCurrent(old.takeCurrent());
    old.destroy();
    this.video = next;
    const now = this.nowUs();
    next.reset(now);
    this.rebuffer();
  }

  play() {
    if (!this.video || this.errorMsg) return;
    if (this.ended) this.seekInternal(0);
    this.wantPlay = true;
    this.message = undefined;
    this.applyClock();
    this.emit(true);
  }

  pause() {
    this.wantPlay = false;
    this.applyClock();
    this.emit(true);
  }

  toggle() {
    if (this.wantPlay && !this.ended) this.pause();
    else this.play();
  }

  seek(sec: number) {
    if (!this.video) return;
    this.seekInternal(clamp(sec, 0, Math.max(0, this.durationSec - 0.25)));
  }

  seekBy(delta: number) {
    this.seek(this.nowUs() / 1e6 + delta);
  }

  setVolume(v: number) {
    this.volume = clamp(v, 0, 1);
    if (this.volume > 0) this.muted = false;
    this.applyVolume();
    this.emit(true);
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyVolume();
    this.emit(true);
  }

  get currentTime() {
    return this.nowUs() / 1e6;
  }

  get hasMedia() {
    return !!this.video;
  }

  unload() {
    this.loadGen++;
    this.teardown();
    this.loading = false;
    this.errorMsg = undefined;
    this.message = undefined;
    this.durationSec = 0;
    this.clearCanvas();
    this.emit(true);
  }

  destroy() {
    this.unload();
    this.ro?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.listeners.clear();
  }

  // ------------------------------------------------------ AudioHost API ----

  get audioCtx(): AudioContext {
    return this.ctx!;
  }

  get audioOut(): AudioNode {
    return this.gain!;
  }

  mediaToCtx(sec: number) {
    return this.anchorCtx + (sec - this.anchorMedia);
  }

  requestRefresh(): Promise<boolean> {
    if (!this.refreshFn) return Promise.resolve(false);
    if (performance.now() - this.lastRefreshOk < 10_000) return Promise.resolve(true);
    if (this.refreshing) return this.refreshing;
    const gen = this.loadGen;
    this.message = 'Refreshing stream link…';
    this.emit(true);
    this.refreshing = (async () => {
      try {
        const spec = await this.refreshFn!();
        if (gen !== this.loadGen) return false;
        this.applyRefreshed(spec);
        this.lastRefreshOk = performance.now();
        this.refreshStrikes = 0;
        this.message = undefined;
        return true;
      } catch {
        if (gen !== this.loadGen) return false;
        if (++this.refreshStrikes >= 3) this.fail('Stream link expired and could not be refreshed.');
        return false;
      } finally {
        this.refreshing = null;
        this.emit(true);
      }
    })();
    return this.refreshing;
  }

  onFetchProblem() {
    this.message = navigator.onLine ? 'Reconnecting…' : 'No signal, waiting for network…';
    this.emit(true);
  }

  onFetchOk() {
    if (this.message && /Reconnecting|No signal/.test(this.message)) this.message = undefined;
    this.emit(true);
  }

  // ----------------------------------------------------------- internals ----

  private setupAudio(sampleRate?: number) {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: 'playback', sampleRate });
    } catch {
      ctx = new AudioContext({ latencyHint: 'playback' });
    }
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.applyVolume();
    ctx.suspend().catch(() => {});
    ctx.onstatechange = () => {
      // Recover from system-initiated suspensions (audio focus, etc.).
      if (this.ctx !== ctx || ctx.state !== 'suspended') return;
      if (this.shouldRun()) setTimeout(() => this.applyClock(), 500);
    };
  }

  private applyVolume() {
    if (!this.gain || !this.ctx) return;
    const v = this.muted ? 0 : this.volume * this.volume; // perceptual curve
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private shouldRun() {
    return this.wantPlay && !this.buffering && !this.ended && !this.errorMsg && !!this.video;
  }

  private applyClock() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    const run = this.shouldRun();
    if (run && ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      clearTimeout(this.autoplayCheck);
      this.autoplayCheck = window.setTimeout(() => {
        // Autoplay policy refused to start audio: fall back to paused.
        if (this.ctx === ctx && this.shouldRun() && ctx.state !== 'running') {
          this.wantPlay = false;
          this.message = 'Tap play to start';
          this.emit(true);
        }
      }, 2000);
    } else if (!run && ctx.state === 'running') {
      ctx.suspend().catch(() => {});
    }
  }

  private nowUs(): number {
    const ctx = this.ctx;
    if (!ctx || !this.video) return this.anchorMedia * 1e6;
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    const t = this.anchorMedia + Math.max(0, ctx.currentTime - this.anchorCtx - latency);
    return Math.min(t, this.durationSec || t) * 1e6;
  }

  private seekInternal(sec: number) {
    if (!this.video || !this.ctx) return;
    const us = Math.round(sec * 1e6);
    this.ended = false;
    this.anchorMedia = sec;
    this.anchorCtx = this.ctx.currentTime;
    this.video.reset(us);
    this.audio?.reset(us);
    this.rebuffer();
  }

  /** Enter buffering for a seek/switch (not counted as a stall). */
  private rebuffer() {
    this.buffering = true;
    this.resumeThresholdUs = 1_000_000;
    this.applyClock();
    this.emit(true);
  }

  private fail(msg: string) {
    this.errorMsg = msg;
    this.wantPlay = false;
    this.applyClock();
    this.abort?.abort();
    this.emit(true);
  }

  private teardown() {
    this.abort?.abort();
    this.abort = null;
    this.video?.destroy();
    this.audio?.destroy();
    this.video = null;
    this.audio = null;
    clearTimeout(this.autoplayCheck);
    if (this.ctx) {
      this.ctx.onstatechange = null;
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.gain = null;
    this.anchorCtx = 0;
    this.anchorMedia = 0;
    this.stopLoop();
  }

  private startLoop() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    // Backstop when rAF is throttled: keeps audio fed and state current.
    if (!this.timer) this.timer = window.setInterval(this.pump, 100);
  }

  private stopLoop() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    this.raf = 0;
    this.timer = 0;
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    this.pump();
    const f = this.video?.render(this.nowUs());
    if (f) this.draw(f);
  };

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.pump();
  };

  private pump = () => {
    const v = this.video;
    const a = this.audio;
    if (!v || this.errorMsg) return;
    const now = this.nowUs();

    if (v.needsRecover) {
      if (v.decoderErrors > 6) return this.fail(`Video decoder keeps failing: ${v.lastError}`);
      // Hardware decoders on car SoCs can be flaky; fall back to software.
      if (v.decoderErrors >= 2) v.hwPref = 'prefer-software';
      v.reset(now);
      this.rebuffer();
    }
    if (a?.needsRecover) {
      if (a.decoderErrors > 6) return this.fail(`Audio decoder keeps failing: ${a.lastError}`);
      a.reset(now);
      this.rebuffer();
    }

    v.pumpFetch(now);
    a?.pumpFetch(now);
    v.feed();
    a?.feed(now);

    this.updateBuffering(now);
    this.checkLag(now);
    this.checkEnded(now);
    this.emit();
  };

  private updateBuffering(nowUs: number) {
    const v = this.video!;
    const a = this.audio;
    const ahead = Math.min(v.bufferedAheadUs(nowUs), a?.bufferedAheadUs(nowUs) ?? Infinity);
    if (!this.buffering) {
      if (this.ended || !this.wantPlay) return;
      if (ahead < 150_000) {
        this.buffering = true;
        this.stallCount++;
        const t = performance.now();
        this.stallTimes = this.stallTimes.filter((x) => t - x < 120_000);
        this.stallTimes.push(t);
        // Each recent stall asks for a bigger cushion before resuming.
        this.resumeThresholdUs = Math.min(2_000_000 * 2 ** (this.stallTimes.length - 1), 15_000_000);
        if (this.stallTimes.length >= 2) this.onQualityHint?.('stalls');
        this.applyClock();
        this.emit(true);
      }
      return;
    }
    const enough = ahead >= this.resumeThresholdUs;
    if (enough && v.readyFor() && (!a || a.readyFor(nowUs))) {
      this.buffering = false;
      this.loading = false;
      if (this.message === 'Refreshing stream link…') this.message = undefined;
      this.applyClock();
      this.emit(true);
    }
  }

  private checkLag(nowUs: number) {
    const v = this.video!;
    if (this.buffering || !this.wantPlay || !v.isLagging(nowUs)) return;
    const t = performance.now();
    if (this.catchUpTimes.length && t - this.catchUpTimes[this.catchUpTimes.length - 1] < 3000) return;
    this.catchUpTimes = this.catchUpTimes.filter((x) => t - x < 60_000);
    this.catchUpTimes.push(t);
    v.catchUp(nowUs);
    if (document.visibilityState === 'visible' && this.catchUpTimes.length >= 3) {
      this.onQualityHint?.('decoder');
    }
  }

  private checkEnded(nowUs: number) {
    if (this.ended || this.loading) return;
    const v = this.video!;
    const a = this.audio;
    const drained = v.isDrained() && (!a || a.isDrained(nowUs));
    const atEnd = this.durationSec > 0 && nowUs >= this.durationSec * 1e6 - 50_000;
    if ((drained && (!a || !this.buffering)) || (atEnd && !this.buffering)) {
      this.ended = true;
      this.wantPlay = false;
      this.buffering = false;
      this.applyClock();
      this.emit(true);
      this.onEnded?.();
    }
  }

  private applyRefreshed(spec: SourceSpec) {
    if (!this.video) return;
    if (spec.type === 'adaptive') {
      this.video.stream.fetcher.url = spec.video.url;
      if (this.audio && spec.audio) this.audio.stream.fetcher.url = spec.audio.url;
    } else {
      this.video.stream.fetcher.url = spec.file.url;
    }
  }

  // --------------------------------------------------------- rendering ----

  private resizeCanvas() {
    const c = this.canvas;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      this.lastRect = '';
      const cur = this.video?.current;
      if (cur) this.draw(cur);
      else this.clearCanvas();
    }
  }

  private clearCanvas() {
    const c = this.canvas;
    const g = this.g2d;
    if (!c || !g) return;
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    this.lastRect = '';
  }

  private draw(f: VideoFrame) {
    const c = this.canvas;
    const g = this.g2d;
    if (!c || !g) return;
    const fw = f.displayWidth;
    const fh = f.displayHeight;
    const s = Math.min(c.width / fw, c.height / fh);
    const w = Math.round(fw * s);
    const h = Math.round(fh * s);
    const x = Math.round((c.width - w) / 2);
    const y = Math.round((c.height - h) / 2);
    const rect = `${x},${y},${w},${h}`;
    if (rect !== this.lastRect) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
      this.lastRect = rect;
    }
    try {
      g.drawImage(f, x, y, w, h);
    } catch {
      /* frame closed underneath us; next frame will draw */
    }
  }

  // ---------------------------------------------------------- snapshots ----

  private state(): PlayerState {
    if (this.errorMsg) return 'error';
    if (this.loading) return 'loading';
    if (!this.video) return 'idle';
    if (this.ended) return 'ended';
    if (this.wantPlay && this.buffering) return 'buffering';
    return this.wantPlay ? 'playing' : 'paused';
  }

  private buildSnapshot(): PlayerSnapshot {
    const now = this.nowUs();
    const v = this.video;
    const a = this.audio;
    const vInfo = v?.info;
    const ahead = v ? Math.min(v.bufferedAheadUs(now), a?.bufferedAheadUs(now) ?? Infinity) : 0;
    return {
      state: this.state(),
      currentTime: now / 1e6,
      duration: this.durationSec,
      bufferedAhead: Number.isFinite(ahead) ? Math.max(0, ahead / 1e6) : this.durationSec - now / 1e6,
      volume: this.volume,
      muted: this.muted,
      message: this.message,
      error: this.errorMsg,
      stats: {
        width: vInfo?.width ?? 0,
        height: vInfo?.height ?? 0,
        videoCodec: vInfo?.codec ?? '',
        audioCodec: a?.info.codec ?? '',
        decodedFrames: v?.decoded ?? 0,
        droppedFrames: v?.dropped ?? 0,
        bandwidthKbps: Math.round(bandwidth.bitsPerSecond / 1000),
        stalls: this.stallCount,
        decoderMode: v?.hwPref ?? '',
        videoBufferSec: v ? v.bufferedSec(now) : 0,
        audioBufferSec: a ? a.bufferedSec(now) : 0,
      },
    };
  }

  private emit(force = false) {
    const t = performance.now();
    if (!force && t - this.lastEmit < 250) return;
    this.lastEmit = t;
    this.snap = this.buildSnapshot();
    for (const l of this.listeners) l();
  }
}

async function pickHwPref(config: VideoDecoderConfig): Promise<HardwareAcceleration> {
  const ok = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (ok.supported) return config.hardwareAcceleration ?? 'no-preference';
  const sw = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' }).catch(
    () => ({ supported: false }),
  );
  if (sw.supported) return 'prefer-software';
  throw new Error(`Video codec ${config.codec} not supported by this browser`);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function webCodecsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'VideoDecoder' in window &&
    'AudioDecoder' in window &&
    'AudioContext' in window
  );
}
