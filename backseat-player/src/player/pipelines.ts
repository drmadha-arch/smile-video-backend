import { UrlExpiredError, isAbort } from './net';
import { findSegment, type TrackStream } from './tracks';
import type { EncodedSample } from './types';

export interface PipelineHost {
  readonly bufferTargetUs: number;
  requestRefresh(): Promise<boolean>;
  onFetchProblem(err: unknown): void;
  onFetchOk(): void;
}

export interface AudioHost extends PipelineHost {
  readonly audioCtx: AudioContext;
  readonly audioOut: AudioNode;
  /** Convert a media time (seconds) to AudioContext time. */
  mediaToCtx(sec: number): number;
}

/**
 * Download side of a track: keeps `bufferTargetUs` of encoded samples queued
 * ahead of the playhead, retrying forever with backoff (tunnels, dead zones).
 */
abstract class TrackPipeline {
  pending: EncodedSample[] = [];
  loadedEndUs = 0;
  allLoaded = false;
  failures = 0;
  protected nextSeg = 0;
  protected epoch = 0;
  private inflight: AbortController | null = null;
  private retryAt = 0;
  private trimToUs: number | null = null;

  constructor(
    protected host: PipelineHost,
    readonly stream: TrackStream,
  ) {}

  protected resetFetch(us: number) {
    this.epoch++;
    this.inflight?.abort();
    this.inflight = null;
    this.pending = [];
    this.nextSeg = findSegment(this.stream.segments, us);
    this.loadedEndUs = this.stream.segments[this.nextSeg]?.startUs ?? 0;
    this.allLoaded = this.nextSeg >= this.stream.segments.length;
    this.retryAt = 0;
    this.failures = 0;
    this.trimToUs = us;
  }

  bufferedAheadUs(nowUs: number): number {
    return this.allLoaded ? Infinity : this.loadedEndUs - nowUs;
  }

  pumpFetch(nowUs: number) {
    if (this.inflight || this.allLoaded) return;
    if (performance.now() < this.retryAt) return;
    if (this.nextSeg >= this.stream.segments.length) {
      this.allLoaded = true;
      return;
    }
    if (this.loadedEndUs - nowUs > this.host.bufferTargetUs) return;
    const ctrl = new AbortController();
    this.inflight = ctrl;
    void this.fetchSegment(this.nextSeg, ctrl, this.epoch);
  }

  private async fetchSegment(idx: number, ctrl: AbortController, epoch: number) {
    try {
      const samples = await this.stream.load(idx, ctrl.signal);
      if (epoch !== this.epoch || ctrl.signal.aborted) return;
      this.append(samples);
      this.nextSeg = idx + 1;
      this.loadedEndUs = this.stream.segments[idx].endUs;
      this.allLoaded = this.nextSeg >= this.stream.segments.length;
      if (this.failures) this.host.onFetchOk();
      this.failures = 0;
    } catch (e) {
      if (epoch !== this.epoch || (isAbort(e) && ctrl.signal.aborted)) return;
      this.failures++;
      this.host.onFetchProblem(e);
      let delay = Math.min(1000 * 2 ** (this.failures - 1), 15_000);
      // Expired URL, or persistent failures that might really be an expired URL.
      if (e instanceof UrlExpiredError || this.failures === 4) {
        const ok = await this.host.requestRefresh();
        if (ok) delay = 0;
      }
      if (epoch === this.epoch) this.retryAt = performance.now() + delay;
    } finally {
      if (this.inflight === ctrl) this.inflight = null;
    }
  }

  private append(samples: EncodedSample[]) {
    let from = 0;
    if (this.trimToUs !== null) {
      // First segment after a seek: start at the last keyframe <= target.
      const target = this.trimToUs;
      this.trimToUs = null;
      let k = -1;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].key && samples[i].ts <= target) k = i;
      }
      if (k < 0) k = Math.max(0, samples.findIndex((s) => s.key));
      from = k;
    }
    for (let i = from; i < samples.length; i++) this.pending.push(samples[i]);
  }

  protected stopFetching() {
    this.epoch++;
    this.inflight?.abort();
    this.inflight = null;
    this.pending = [];
  }
}

// ================================================================ video ====

const MAX_FRAMES = 6;
const MAX_DECODE_QUEUE = 4;

export class VideoPipeline extends TrackPipeline {
  frames: VideoFrame[] = [];
  current: VideoFrame | null = null;
  /** `current` belongs to the pre-seek position; replace it ASAP. */
  currentStale = false;
  hwPref: HardwareAcceleration = 'no-preference';
  decoderErrors = 0;
  needsRecover = false;
  lastError = '';
  decoded = 0;
  dropped = 0;

  private decoder: VideoDecoder | null = null;
  private decGen = 0;
  private needKey = true;
  private flushed = false;
  private discardBeforeUs = 0;

  get info() {
    const i = this.stream.info;
    if (i.kind !== 'video') throw new Error('not a video track');
    return i;
  }

  config(): VideoDecoderConfig {
    const i = this.info;
    return {
      codec: i.codec,
      description: i.description,
      codedWidth: i.width,
      codedHeight: i.height,
      hardwareAcceleration: this.hwPref,
      optimizeForLatency: false,
    };
  }

  private createDecoder() {
    const gen = ++this.decGen;
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = new VideoDecoder({
      output: (f) => this.onFrame(f, gen),
      error: (e) => this.onError(e, gen),
    });
    this.decoder.configure(this.config());
  }

  private onFrame(f: VideoFrame, gen: number) {
    if (gen !== this.decGen) return f.close();
    this.decoded++;
    if (f.timestamp + (f.duration ?? 33_000) <= this.discardBeforeUs) return f.close();
    // Decoder output is presentation-ordered, but be defensive.
    const fs = this.frames;
    if (fs.length && fs[fs.length - 1].timestamp > f.timestamp) {
      const at = fs.findIndex((x) => x.timestamp > f.timestamp);
      fs.splice(at, 0, f);
    } else {
      fs.push(f);
    }
  }

  private onError(e: DOMException | Error, gen: number) {
    if (gen !== this.decGen) return;
    this.decoderErrors++;
    this.lastError = e.message;
    this.needsRecover = true;
  }

  private clearFrames() {
    for (const f of this.frames) f.close();
    this.frames = [];
  }

  /** Seek: drop everything and restart decoding from the keyframe <= us. */
  reset(us: number) {
    this.resetFetch(us);
    this.clearFrames();
    if (this.current) this.currentStale = true;
    this.discardBeforeUs = us;
    this.needKey = true;
    this.flushed = false;
    this.needsRecover = false;
    this.createDecoder();
  }

  /**
   * Decoder fell behind the clock (e.g. tab was hidden, slow hardware).
   * Jump to the newest keyframe <= now already in the queue when possible.
   */
  catchUp(nowUs: number) {
    let k = -1;
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i].key && this.pending[i].ts <= nowUs) k = i;
    }
    if (k < 0) {
      if (this.pending.length && this.pending[0].ts > nowUs) return; // nothing to gain
      this.reset(nowUs);
      return;
    }
    this.pending = this.pending.slice(k);
    this.clearFrames();
    this.discardBeforeUs = nowUs;
    this.needKey = true;
    this.flushed = false;
    this.createDecoder();
  }

  feed() {
    const d = this.decoder;
    if (!d || d.state !== 'configured' || this.needsRecover) return;
    while (this.pending.length && d.decodeQueueSize < MAX_DECODE_QUEUE && this.frames.length < MAX_FRAMES) {
      const s = this.pending.shift()!;
      if (this.needKey) {
        if (!s.key) continue;
        this.needKey = false;
      }
      try {
        d.decode(
          new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, duration: s.dur, data: s.data }),
        );
      } catch (e) {
        this.onError(e as Error, this.decGen);
        return;
      }
    }
    if (!this.pending.length && this.allLoaded && !this.flushed) {
      this.flushed = true;
      d.flush().catch(() => {});
    }
  }

  /** Pick the frame for `nowUs`. Returns a frame only when it changed. */
  render(nowUs: number): VideoFrame | null {
    let next: VideoFrame | null = null;
    while (this.frames.length && this.frames[0].timestamp <= nowUs + 8_000) {
      if (next) {
        next.close();
        this.dropped++;
      }
      next = this.frames.shift()!;
    }
    if (!next && this.frames.length && (!this.current || this.currentStale)) {
      next = this.frames.shift()!;
    }
    if (!next) return null;
    this.current?.close();
    this.current = next;
    this.currentStale = false;
    return next;
  }

  /** True when playback can (re)start without immediately starving video. */
  readyFor(): boolean {
    if (this.needsRecover) return false;
    // Give the decoder a head start so it isn't racing the clock from frame 1.
    if (this.frames.length >= Math.min(4, MAX_FRAMES)) return true;
    if (this.frames.length > 0 && this.pending.length === 0) return true;
    return this.isDrained() && !this.currentStale;
  }

  isDrained(): boolean {
    return (
      this.allLoaded &&
      this.pending.length === 0 &&
      this.frames.length === 0 &&
      (this.decoder?.decodeQueueSize ?? 0) === 0
    );
  }

  isLagging(nowUs: number): boolean {
    if (!this.current || this.currentStale || this.needsRecover) return false;
    const behind = nowUs - this.current.timestamp;
    return behind > 1_500_000 && this.frames.length === 0 && this.pending.length > 0;
  }

  bufferedSec(nowUs: number) {
    const last = this.pending.length ? this.pending[this.pending.length - 1] : null;
    return last ? Math.max(0, (last.ts - nowUs) / 1e6) : 0;
  }

  takeCurrent(): VideoFrame | null {
    const c = this.current;
    this.current = null;
    return c;
  }

  adoptCurrent(f: VideoFrame | null) {
    this.current?.close();
    this.current = f;
    this.currentStale = !!f;
  }

  destroy() {
    this.stopFetching();
    this.decGen++;
    this.clearFrames();
    this.current?.close();
    this.current = null;
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = null;
  }
}

// ================================================================ audio ====

export class AudioPipeline extends TrackPipeline {
  decoderErrors = 0;
  needsRecover = false;
  lastError = '';
  scheduledEndUs = 0;

  private decoder: AudioDecoder | null = null;
  private decGen = 0;
  private acc: AudioData[] = [];
  private accFrames = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private fedEndUs = 0;
  private nextCtxTime = -1;
  private discardBeforeUs = 0;
  private flushed = false;

  constructor(
    protected host: AudioHost,
    stream: TrackStream,
  ) {
    super(host, stream);
  }

  get info() {
    const i = this.stream.info;
    if (i.kind !== 'audio') throw new Error('not an audio track');
    return i;
  }

  config(): AudioDecoderConfig {
    const i = this.info;
    return { codec: i.codec, description: i.description, sampleRate: i.sampleRate, numberOfChannels: i.channels };
  }

  private createDecoder() {
    const gen = ++this.decGen;
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = new AudioDecoder({
      output: (d) => this.onData(d, gen),
      error: (e) => {
        if (gen !== this.decGen) return;
        this.decoderErrors++;
        this.lastError = e.message;
        this.needsRecover = true;
      },
    });
    this.decoder.configure(this.config());
  }

  private stopSources() {
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources.clear();
  }

  private clearAcc() {
    for (const a of this.acc) a.close();
    this.acc = [];
    this.accFrames = 0;
  }

  reset(us: number) {
    this.resetFetch(us);
    this.stopSources();
    this.clearAcc();
    this.discardBeforeUs = us;
    this.fedEndUs = 0;
    this.scheduledEndUs = us;
    this.nextCtxTime = -1;
    this.flushed = false;
    this.needsRecover = false;
    this.createDecoder();
  }

  feed(nowUs: number) {
    const d = this.decoder;
    if (!d || d.state !== 'configured' || this.needsRecover) return;
    // Keep ~4s decoded ahead: cheap, and rides out short main-thread hiccups.
    while (this.pending.length && d.decodeQueueSize < 32 && this.fedEndUs - nowUs < 4_000_000) {
      const s = this.pending.shift()!;
      try {
        d.decode(new EncodedAudioChunk({ type: 'key', timestamp: s.ts, duration: s.dur, data: s.data }));
      } catch (e) {
        this.decoderErrors++;
        this.lastError = (e as Error).message;
        this.needsRecover = true;
        return;
      }
      this.fedEndUs = s.ts + s.dur;
    }
    if (!this.pending.length && this.allLoaded && !this.flushed) {
      this.flushed = true;
      const gen = this.decGen;
      d.flush()
        .then(() => gen === this.decGen && this.flushAcc())
        .catch(() => {});
    }
    // Don't let a partially filled block sit while its time approaches.
    if (this.acc.length && this.acc[0].timestamp - nowUs < 1_000_000) this.flushAcc();
  }

  private onData(ad: AudioData, gen: number) {
    if (gen !== this.decGen) return ad.close();
    if (ad.timestamp + ad.duration <= this.discardBeforeUs) return ad.close();
    if (this.acc.length) {
      const last = this.acc[this.acc.length - 1];
      const gap = Math.abs(last.timestamp + last.duration - ad.timestamp);
      if (gap > 20_000 || last.numberOfChannels !== ad.numberOfChannels) this.flushAcc();
    }
    this.acc.push(ad);
    this.accFrames += ad.numberOfFrames;
    // Merge ~250ms of AAC frames per AudioBufferSourceNode.
    if (this.accFrames >= ad.sampleRate * 0.25) this.flushAcc();
  }

  private flushAcc() {
    if (!this.acc.length) return;
    const ctx = this.host.audioCtx;
    if (ctx.state === 'closed') return this.clearAcc();
    const first = this.acc[0];
    const channels = first.numberOfChannels;
    const buffer = ctx.createBuffer(channels, this.accFrames, first.sampleRate);
    const tmp = new Float32Array(this.accFrames);
    for (let ch = 0; ch < channels; ch++) {
      let off = 0;
      for (const ad of this.acc) {
        copyPlane(ad, ch, tmp.subarray(off, off + ad.numberOfFrames));
        off += ad.numberOfFrames;
      }
      buffer.copyToChannel(tmp, ch);
    }
    const tsUs = first.timestamp;
    this.clearAcc();
    this.schedule(buffer, tsUs);
  }

  private schedule(buffer: AudioBuffer, tsUs: number) {
    const ctx = this.host.audioCtx;
    let when = this.host.mediaToCtx(tsUs / 1e6);
    // Snap to the end of the previous block to avoid clicks from rounding.
    if (this.nextCtxTime > 0 && Math.abs(when - this.nextCtxTime) < 0.015) when = this.nextCtxTime;
    let offset = 0;
    const now = ctx.currentTime;
    if (when < now) {
      offset = now - when;
      when = now;
    }
    this.scheduledEndUs = tsUs + buffer.duration * 1e6;
    if (offset >= buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.host.audioOut);
    src.start(when, offset);
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      src.disconnect();
    };
    this.nextCtxTime = when + buffer.duration - offset;
  }

  readyFor(nowUs: number): boolean {
    if (this.needsRecover) return false;
    if (this.scheduledEndUs - nowUs >= 300_000) return true;
    return this.allLoaded && this.pending.length === 0 && (this.decoder?.decodeQueueSize ?? 0) === 0;
  }

  isDrained(nowUs: number): boolean {
    return this.allLoaded && this.pending.length === 0 && nowUs >= this.scheduledEndUs;
  }

  bufferedSec(nowUs: number) {
    const last = this.pending.length ? this.pending[this.pending.length - 1] : null;
    const end = Math.max(this.scheduledEndUs, last ? last.ts + last.dur : 0);
    return Math.max(0, (end - nowUs) / 1e6);
  }

  destroy() {
    this.stopFetching();
    this.decGen++;
    this.stopSources();
    this.clearAcc();
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = null;
  }
}

function copyPlane(ad: AudioData, ch: number, dst: Float32Array) {
  try {
    ad.copyTo(dst, { planeIndex: ch, format: 'f32-planar' });
    return;
  } catch {
    /* fall back to native-format conversion below */
  }
  const n = ad.numberOfFrames;
  const c = ad.numberOfChannels;
  switch (ad.format) {
    case 'f32-planar':
      ad.copyTo(dst, { planeIndex: ch });
      return;
    case 'f32': {
      const t = new Float32Array(n * c);
      ad.copyTo(t, { planeIndex: 0 });
      for (let i = 0; i < n; i++) dst[i] = t[i * c + ch];
      return;
    }
    case 's16': {
      const t = new Int16Array(n * c);
      ad.copyTo(t, { planeIndex: 0 });
      for (let i = 0; i < n; i++) dst[i] = t[i * c + ch] / 32768;
      return;
    }
    case 's16-planar': {
      const t = new Int16Array(n);
      ad.copyTo(t, { planeIndex: ch });
      for (let i = 0; i < n; i++) dst[i] = t[i] / 32768;
      return;
    }
    default:
      dst.fill(0);
  }
}
