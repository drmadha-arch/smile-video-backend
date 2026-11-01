import { ChunkCache, RangeFetcher } from './net';
import {
  Mp4Error,
  parseFragments,
  parseMoov,
  parseSidx,
  readBoxHeader,
  type MovieInit,
  type RawSample,
  type TrackInit,
} from './mp4';
import type { EncodedSample, RemoteFile, Segment, SourceSpec, TrackInfo } from './types';

/**
 * A track split into independently fetchable time segments. Video segments
 * always start on a keyframe, so any segment is a valid decode entry point.
 */
export interface TrackStream {
  readonly info: TrackInfo;
  readonly segments: Segment[];
  readonly durationSec: number;
  readonly fetcher: RangeFetcher;
  load(index: number, signal: AbortSignal): Promise<EncodedSample[]>;
}

export function findSegment(segments: Segment[], us: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].startUs <= us) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function toInfo(t: TrackInit): TrackInfo {
  return t.kind === 'video'
    ? { kind: 'video', codec: t.codec, description: t.description, width: t.width!, height: t.height! }
    : { kind: 'audio', codec: t.codec, description: t.description, sampleRate: t.sampleRate!, channels: t.channels! };
}

function toEncoded(raw: RawSample[], bytes: Uint8Array, bytesFileOffset: number, t: TrackInit): EncodedSample[] {
  const scale = 1e6 / t.timescale;
  const out: EncodedSample[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const from = r.offset - bytesFileOffset;
    out[i] = {
      data: bytes.subarray(from, from + r.size),
      ts: Math.round((r.dts + r.cto - t.editOffsetTs) * scale),
      dur: Math.round(r.duration * scale),
      key: r.key,
    };
  }
  return out;
}

// ------------------------------------------------------------- probing ----

interface Probe {
  movie: MovieInit;
  sidx?: { bytes: Uint8Array; offset: number };
}

/**
 * Walk top-level boxes to find moov (and sidx for DASH). Handles moov at the
 * start (faststart / DASH) and at the end (non-faststart) of the file.
 */
async function probe(fetcher: RangeFetcher, file: RemoteFile, signal: AbortSignal): Promise<Probe> {
  const headLen = file.indexRange
    ? Math.max(file.indexRange[1], file.initRange?.[1] ?? 0) + 1
    : file.initRange
      ? file.initRange[1] + 1 + 4096
      : 128 * 1024;
  let head = await fetcher.read(0, headLen, signal);

  const bytesAt = async (a: number, b: number): Promise<Uint8Array> => {
    if (b <= head.byteLength) return head.subarray(a, b);
    if (a <= head.byteLength && b - head.byteLength < 8 * 1024 * 1024) {
      const more = await fetcher.read(head.byteLength, b + 64 * 1024, signal);
      const merged = new Uint8Array(head.byteLength + more.byteLength);
      merged.set(head, 0);
      merged.set(more, head.byteLength);
      head = merged;
      return head.subarray(a, Math.min(b, head.byteLength));
    }
    return fetcher.read(a, b, signal);
  };

  let moov: Uint8Array | undefined;
  let sidx: Probe['sidx'];
  let off = 0;
  for (let i = 0; i < 32; i++) {
    const total = fetcher.totalSize;
    if (total !== undefined && off >= total) break;
    const hdrBytes = await bytesAt(off, off + 16);
    if (hdrBytes.byteLength < 8) break;
    const dv = new DataView(hdrBytes.buffer, hdrBytes.byteOffset, hdrBytes.byteLength);
    const hdr = readBoxHeader(dv, 0, hdrBytes.byteLength);
    if (!hdr) break;
    let size = hdr.end - hdr.start;
    if (dv.getUint32(0) === 0) {
      if (total === undefined) break;
      size = total - off;
    }
    if (hdr.type === 'moov') {
      moov = await bytesAt(off, off + size);
    } else if (hdr.type === 'sidx' && !sidx) {
      sidx = { bytes: await bytesAt(off, off + size), offset: off };
    } else if (hdr.type === 'moof') {
      break; // DASH: index boxes always precede the first fragment
    } else if (hdr.type === 'mdat' && moov) {
      break;
    }
    if (moov && sidx) break;
    off += size;
  }
  if (!moov) throw new Mp4Error('Could not find movie header (moov)');
  return { movie: parseMoov(moov), sidx };
}

// ------------------------------------------------------ fragmented DASH ----

class FragmentedStream implements TrackStream {
  readonly info: TrackInfo;
  readonly segments: Segment[];
  readonly durationSec: number;
  private ranges: { start: number; end: number }[];

  constructor(
    readonly fetcher: RangeFetcher,
    private track: TrackInit,
    sidx: { bytes: Uint8Array; offset: number },
    movieDuration: number,
  ) {
    this.info = toInfo(track);
    const segs = parseSidx(sidx.bytes, sidx.offset);
    if (!segs.length) throw new Mp4Error('Empty segment index');
    this.ranges = segs.map((s) => ({ start: s.start, end: s.end }));
    this.segments = segs.map((s) => ({
      startUs: Math.round(s.startSec * 1e6),
      endUs: Math.round((s.startSec + s.durationSec) * 1e6),
    }));
    const last = segs[segs.length - 1];
    this.durationSec = Math.max(movieDuration, last.startSec + last.durationSec);
  }

  async load(index: number, signal: AbortSignal): Promise<EncodedSample[]> {
    const r = this.ranges[index];
    const bytes = await this.fetcher.read(r.start, r.end, signal);
    const raw = parseFragments(bytes, r.start, this.track);
    return toEncoded(raw, bytes, r.start, this.track);
  }
}

// ------------------------------------------------ progressive (muxed) ----

class ProgressiveStream implements TrackStream {
  readonly info: TrackInfo;
  readonly segments: Segment[] = [];
  readonly durationSec: number;
  private groups: { from: number; to: number; start: number; end: number }[] = [];

  constructor(
    private cache: ChunkCache,
    private track: TrackInit,
    movieDuration: number,
  ) {
    this.info = toInfo(track);
    const tb = track.table!;
    const scale = 1e6 / track.timescale;
    const ptsUs = (i: number) => (tb.dts[i] + tb.cto[i] - track.editOffsetTs) * scale;
    // Group samples into ~4s runs; video groups must begin on a sync sample.
    const minGroupUs = 4e6;
    let from = 0;
    let groupStartDts = tb.dts[0] ?? 0;
    const flush = (to: number) => {
      if (to <= from) return;
      let start = Infinity;
      let end = 0;
      let minPts = Infinity;
      for (let i = from; i < to; i++) {
        start = Math.min(start, tb.offsets[i]);
        end = Math.max(end, tb.offsets[i] + tb.sizes[i]);
        minPts = Math.min(minPts, ptsUs(i));
      }
      this.groups.push({ from, to, start, end });
      this.segments.push({ startUs: Math.max(0, Math.round(minPts)), endUs: 0 });
      from = to;
    };
    for (let i = 1; i < tb.count; i++) {
      const longEnough = (tb.dts[i] - groupStartDts) * scale >= minGroupUs;
      const boundaryOk = track.kind === 'audio' || tb.sync[i] === 1;
      if (longEnough && boundaryOk) {
        flush(i);
        groupStartDts = tb.dts[i];
      }
    }
    flush(tb.count);
    const durUs = Math.round(
      Math.max(movieDuration, track.durationTs / track.timescale) * 1e6,
    );
    for (let i = 0; i < this.segments.length; i++) {
      this.segments[i].endUs = i + 1 < this.segments.length ? this.segments[i + 1].startUs : durUs;
    }
    if (this.segments.length) this.segments[0].startUs = 0;
    this.durationSec = durUs / 1e6;
  }

  get fetcher() {
    return this.cache.fetcher;
  }

  async load(index: number, signal: AbortSignal): Promise<EncodedSample[]> {
    const g = this.groups[index];
    const bytes = await this.cache.read(g.start, g.end, signal);
    const tb = this.track.table!;
    const raw: RawSample[] = [];
    for (let i = g.from; i < g.to; i++) {
      raw.push({
        offset: tb.offsets[i],
        size: tb.sizes[i],
        dts: tb.dts[i],
        cto: tb.cto[i],
        duration: tb.durations[i],
        key: this.track.kind === 'audio' || tb.sync[i] === 1,
      });
    }
    return toEncoded(raw, bytes, g.start, this.track);
  }
}

// ------------------------------------------------------------- opening ----

export interface OpenedSource {
  video?: TrackStream;
  audio?: TrackStream;
  durationSec: number;
}

async function openFile(
  file: RemoteFile,
  signal: AbortSignal,
): Promise<{ fetcher: RangeFetcher; probe: Probe }> {
  const fetcher = new RangeFetcher(file.url, file.contentLength);
  return { fetcher, probe: await probe(fetcher, file, signal) };
}

function fragmentedTrack(
  fetcher: RangeFetcher,
  p: Probe,
  kind: 'video' | 'audio',
): TrackStream {
  const t = p.movie.tracks.find((x) => x.kind === kind);
  if (!t) throw new Mp4Error(`No ${kind} track in stream`);
  if (!p.movie.fragmented || !p.sidx) throw new Mp4Error(`${kind} stream has no segment index`);
  return new FragmentedStream(fetcher, t, p.sidx, p.movie.durationSec);
}

export async function openVideoFile(file: RemoteFile, signal: AbortSignal): Promise<TrackStream> {
  const { fetcher, probe: p } = await openFile(file, signal);
  return fragmentedTrack(fetcher, p, 'video');
}

export async function openSource(spec: SourceSpec, signal: AbortSignal): Promise<OpenedSource> {
  if (spec.type === 'adaptive') {
    const [v, a] = await Promise.all([
      openFile(spec.video, signal),
      spec.audio ? openFile(spec.audio, signal) : Promise.resolve(undefined),
    ]);
    const video = fragmentedTrack(v.fetcher, v.probe, 'video');
    const audio = a ? fragmentedTrack(a.fetcher, a.probe, 'audio') : undefined;
    return {
      video,
      audio,
      durationSec: Math.max(video.durationSec, audio?.durationSec ?? 0),
    };
  }

  const { fetcher, probe: p } = await openFile(spec.file, signal);
  if (p.movie.fragmented) {
    // A muxed fragmented file: not something YouTube serves; keep it simple.
    throw new Mp4Error('Fragmented muxed files are not supported');
  }
  const cache = new ChunkCache(fetcher);
  const vt = p.movie.tracks.find((t) => t.kind === 'video');
  const at = p.movie.tracks.find((t) => t.kind === 'audio');
  if (!vt) throw new Mp4Error('No video track in file');
  const video = new ProgressiveStream(cache, vt, p.movie.durationSec);
  const audio = at ? new ProgressiveStream(cache, at, p.movie.durationSec) : undefined;
  return { video, audio, durationSec: Math.max(video.durationSec, audio?.durationSec ?? 0) };
}
