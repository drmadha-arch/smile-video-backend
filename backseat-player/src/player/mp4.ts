/**
 * Minimal ISO-BMFF (MP4) parser. Covers exactly what YouTube serves:
 *  - Fragmented DASH MP4 (ftyp, moov+mvex, sidx, moof/mdat) for adaptive formats
 *  - Progressive "faststart" MP4 (moov with full sample tables) for muxed itag 18
 *
 * Supports H.264 (avc1/avc3) video and AAC (mp4a) audio. That is all WebCodecs
 * needs from the container: a codec string, a decoder description, and samples.
 */

export interface BoxRef {
  type: string;
  /** Absolute offset of the box start within the parsed buffer. */
  start: number;
  /** Offset where the payload begins (after header). */
  payload: number;
  /** Absolute offset one past the end of the box. */
  end: number;
}

export interface SampleTable {
  count: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  dts: Float64Array;
  cto: Int32Array;
  durations: Uint32Array;
  sync: Uint8Array;
}

export interface TrackInit {
  id: number;
  kind: 'video' | 'audio';
  timescale: number;
  durationTs: number;
  codec: string;
  description?: Uint8Array;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  /** Media-time offset from the edit list; subtract from composition times. */
  editOffsetTs: number;
  /** Present for progressive (non-fragmented) files. */
  table?: SampleTable;
  /** trex defaults for fragmented files. */
  trex?: { duration: number; size: number; flags: number };
}

export interface MovieInit {
  tracks: TrackInit[];
  fragmented: boolean;
  durationSec: number;
}

export interface SidxSegment {
  start: number;
  end: number; // exclusive
  startSec: number;
  durationSec: number;
}

/** A sample as located in the file, before its bytes are fetched. */
export interface RawSample {
  offset: number;
  size: number;
  dts: number;
  cto: number;
  duration: number;
  key: boolean;
}

export class Mp4Error extends Error {}

function fourcc(dv: DataView, at: number): string {
  return String.fromCharCode(
    dv.getUint8(at),
    dv.getUint8(at + 1),
    dv.getUint8(at + 2),
    dv.getUint8(at + 3),
  );
}

function u64(dv: DataView, at: number): number {
  return dv.getUint32(at) * 0x100000000 + dv.getUint32(at + 4);
}

function dataView(u8: Uint8Array): DataView {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

/** Reads a box header at `at`. Returns null if not enough bytes for a header. */
export function readBoxHeader(
  dv: DataView,
  at: number,
  limit = dv.byteLength,
): BoxRef | null {
  if (at + 8 > limit) return null;
  let size = dv.getUint32(at);
  const type = fourcc(dv, at + 4);
  let header = 8;
  if (size === 1) {
    if (at + 16 > limit) return null;
    size = u64(dv, at + 8);
    header = 16;
  } else if (size === 0) {
    size = limit - at;
  }
  if (size < header) throw new Mp4Error(`Bad box size for ${type}`);
  return { type, start: at, payload: at + header, end: at + size };
}

export function children(dv: DataView, start: number, end: number): BoxRef[] {
  const out: BoxRef[] = [];
  let at = start;
  while (at + 8 <= end) {
    const b = readBoxHeader(dv, at, end);
    if (!b) break;
    out.push(b);
    if (b.end <= at) break;
    at = b.end;
  }
  return out;
}

function child(dv: DataView, parent: BoxRef, type: string): BoxRef | undefined {
  return children(dv, parent.payload, parent.end).find((b) => b.type === type);
}

function path(dv: DataView, parent: BoxRef, ...types: string[]): BoxRef | undefined {
  let cur: BoxRef | undefined = parent;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(dv, cur, t);
  }
  return cur;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

// ---------------------------------------------------------------- moov ----

export function parseMoov(moovBytes: Uint8Array): MovieInit {
  const dv = dataView(moovBytes);
  const moov = readBoxHeader(dv, 0);
  if (!moov || moov.type !== 'moov') throw new Mp4Error('Expected moov box');

  let movieTimescale = 1000;
  let movieDuration = 0;
  const mvhd = child(dv, moov, 'mvhd');
  if (mvhd) {
    const v = dv.getUint8(mvhd.payload);
    if (v === 1) {
      movieTimescale = dv.getUint32(mvhd.payload + 20);
      movieDuration = u64(dv, mvhd.payload + 24);
    } else {
      movieTimescale = dv.getUint32(mvhd.payload + 12);
      movieDuration = dv.getUint32(mvhd.payload + 16);
    }
  }

  const mvex = child(dv, moov, 'mvex');
  const trexById = new Map<number, { duration: number; size: number; flags: number }>();
  let fragmentDuration = 0;
  if (mvex) {
    for (const b of children(dv, mvex.payload, mvex.end)) {
      if (b.type === 'trex') {
        const p = b.payload + 4;
        trexById.set(dv.getUint32(p), {
          duration: dv.getUint32(p + 8),
          size: dv.getUint32(p + 12),
          flags: dv.getUint32(p + 16),
        });
      } else if (b.type === 'mehd') {
        const v = dv.getUint8(b.payload);
        fragmentDuration = v === 1 ? u64(dv, b.payload + 4) : dv.getUint32(b.payload + 4);
      }
    }
  }

  const tracks: TrackInit[] = [];
  for (const trak of children(dv, moov.payload, moov.end)) {
    if (trak.type !== 'trak') continue;
    const t = parseTrak(dv, trak, !!mvex);
    if (t) {
      t.trex = trexById.get(t.id);
      tracks.push(t);
    }
  }

  const durTs = fragmentDuration || movieDuration;
  let durationSec = durTs / movieTimescale;
  for (const t of tracks) {
    if (t.durationTs > 0) durationSec = Math.max(durationSec, t.durationTs / t.timescale);
  }
  return { tracks, fragmented: !!mvex, durationSec };
}

function parseTrak(dv: DataView, trak: BoxRef, fragmented: boolean): TrackInit | null {
  const tkhd = child(dv, trak, 'tkhd');
  const mdia = child(dv, trak, 'mdia');
  if (!tkhd || !mdia) return null;
  const tkv = dv.getUint8(tkhd.payload);
  const id = dv.getUint32(tkhd.payload + (tkv === 1 ? 20 : 12));

  const mdhd = child(dv, mdia, 'mdhd');
  const hdlr = child(dv, mdia, 'hdlr');
  if (!mdhd || !hdlr) return null;
  const mv = dv.getUint8(mdhd.payload);
  const timescale = dv.getUint32(mdhd.payload + (mv === 1 ? 20 : 12));
  const durationTs = mv === 1 ? u64(dv, mdhd.payload + 24) : dv.getUint32(mdhd.payload + 16);
  const handler = fourcc(dv, hdlr.payload + 8);
  if (handler !== 'vide' && handler !== 'soun') return null;

  const stbl = path(dv, mdia, 'minf', 'stbl');
  if (!stbl) return null;
  const stsd = child(dv, stbl, 'stsd');
  if (!stsd) return null;
  const entry = readBoxHeader(dv, stsd.payload + 8, stsd.end);
  if (!entry) return null;

  const track: TrackInit = {
    id,
    kind: handler === 'vide' ? 'video' : 'audio',
    timescale,
    durationTs,
    codec: '',
    editOffsetTs: 0,
  };

  if (track.kind === 'video') {
    if (entry.type !== 'avc1' && entry.type !== 'avc3') {
      throw new Mp4Error(`Unsupported video codec "${entry.type}" (need H.264)`);
    }
    track.width = dv.getUint16(entry.payload + 24);
    track.height = dv.getUint16(entry.payload + 26);
    const avcC = children(dv, entry.payload + 78, entry.end).find((b) => b.type === 'avcC');
    if (!avcC) throw new Mp4Error('avcC box missing');
    const p = avcC.payload;
    track.codec = `${entry.type}.${hex2(dv.getUint8(p + 1))}${hex2(dv.getUint8(p + 2))}${hex2(dv.getUint8(p + 3))}`;
    track.description = copyBytes(dv, p, avcC.end);
  } else {
    if (entry.type !== 'mp4a') {
      throw new Mp4Error(`Unsupported audio codec "${entry.type}" (need AAC)`);
    }
    const version = dv.getUint16(entry.payload + 8);
    track.channels = dv.getUint16(entry.payload + 16);
    track.sampleRate = dv.getUint32(entry.payload + 24) >>> 16;
    let childStart = entry.payload + 28;
    if (version === 1) childStart += 16;
    else if (version === 2) childStart += 36;
    const esds = children(dv, childStart, entry.end).find((b) => b.type === 'esds');
    if (!esds) throw new Mp4Error('esds box missing');
    const asc = parseEsds(dv, esds);
    if (!asc || asc.length < 2) throw new Mp4Error('AAC config missing');
    let aot = asc[0] >> 3;
    if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
    track.codec = `mp4a.40.${aot}`;
    track.description = asc;
    // Prefer the sampling rate from the AudioSpecificConfig when it is explicit.
    const freqIdx = ((asc[0] & 7) << 1) | (asc[1] >> 7);
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    if (aot === 2 && freqIdx < rates.length) track.sampleRate = rates[freqIdx];
    const chanCfg = (asc[1] >> 3) & 0xf;
    if (aot === 2 && chanCfg > 0 && chanCfg <= 2) track.channels = chanCfg;
  }

  // Edit list: honour a single media_time offset (common B-frame / AAC priming shift).
  const elst = path(dv, trak, 'edts', 'elst');
  if (elst) {
    const v = dv.getUint8(elst.payload);
    const n = dv.getUint32(elst.payload + 4);
    let at = elst.payload + 8;
    for (let i = 0; i < n; i++) {
      const mediaTime = v === 1 ? u64(dv, at + 8) : dv.getInt32(at + 4);
      at += v === 1 ? 20 : 12;
      // u64 of -1 reads as a huge number; skip empty edits either way.
      if (mediaTime >= 0 && mediaTime < 2 ** 52 && mediaTime !== 0xffffffff) {
        track.editOffsetTs = mediaTime;
        break;
      }
    }
  }
  if (!fragmented) track.table = parseSampleTable(dv, stbl);
  return track;
}

function copyBytes(dv: DataView, start: number, end: number): Uint8Array {
  return new Uint8Array(dv.buffer.slice(dv.byteOffset + start, dv.byteOffset + end));
}

function parseEsds(dv: DataView, esds: BoxRef): Uint8Array | null {
  let at = esds.payload + 4; // skip fullbox header
  const end = esds.end;
  const readDesc = (): { tag: number; len: number; body: number } | null => {
    if (at >= end) return null;
    const tag = dv.getUint8(at++);
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = dv.getUint8(at++);
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag, len, body: at };
  };
  const es = readDesc();
  if (!es || es.tag !== 0x03) return null;
  at += 2; // ES_ID
  const flags = dv.getUint8(at++);
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + dv.getUint8(at);
  if (flags & 0x20) at += 2;
  const dc = readDesc();
  if (!dc || dc.tag !== 0x04) return null;
  at += 13;
  const dsi = readDesc();
  if (!dsi || dsi.tag !== 0x05) return null;
  return copyBytes(dv, dsi.body, dsi.body + dsi.len);
}

function parseSampleTable(dv: DataView, stbl: BoxRef): SampleTable {
  const kids = children(dv, stbl.payload, stbl.end);
  const find = (t: string) => kids.find((b) => b.type === t);

  const stsz = find('stsz');
  if (!stsz) throw new Mp4Error('stsz missing');
  const fixedSize = dv.getUint32(stsz.payload + 4);
  const count = dv.getUint32(stsz.payload + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    sizes[i] = fixedSize || dv.getUint32(stsz.payload + 12 + i * 4);
  }

  // Decode timestamps + durations.
  const dts = new Float64Array(count);
  const durations = new Uint32Array(count);
  const stts = find('stts');
  if (stts) {
    const n = dv.getUint32(stts.payload + 4);
    let s = 0;
    let t = 0;
    for (let i = 0; i < n && s < count; i++) {
      const c = dv.getUint32(stts.payload + 8 + i * 8);
      const d = dv.getUint32(stts.payload + 12 + i * 8);
      for (let j = 0; j < c && s < count; j++, s++) {
        dts[s] = t;
        durations[s] = d;
        t += d;
      }
    }
  }

  const cto = new Int32Array(count);
  const ctts = find('ctts');
  if (ctts) {
    const n = dv.getUint32(ctts.payload + 4);
    let s = 0;
    for (let i = 0; i < n && s < count; i++) {
      const c = dv.getUint32(ctts.payload + 8 + i * 8);
      const o = dv.getInt32(ctts.payload + 12 + i * 8);
      for (let j = 0; j < c && s < count; j++) cto[s++] = o;
    }
  }

  const sync = new Uint8Array(count);
  const stss = find('stss');
  if (stss) {
    const n = dv.getUint32(stss.payload + 4);
    for (let i = 0; i < n; i++) {
      const idx = dv.getUint32(stss.payload + 8 + i * 4) - 1;
      if (idx >= 0 && idx < count) sync[idx] = 1;
    }
  } else {
    sync.fill(1);
  }

  // Chunk offsets.
  const stco = find('stco');
  const co64 = find('co64');
  let chunkOffsets: Float64Array;
  if (stco) {
    const n = dv.getUint32(stco.payload + 4);
    chunkOffsets = new Float64Array(n);
    for (let i = 0; i < n; i++) chunkOffsets[i] = dv.getUint32(stco.payload + 8 + i * 4);
  } else if (co64) {
    const n = dv.getUint32(co64.payload + 4);
    chunkOffsets = new Float64Array(n);
    for (let i = 0; i < n; i++) chunkOffsets[i] = u64(dv, co64.payload + 8 + i * 8);
  } else {
    throw new Mp4Error('stco/co64 missing');
  }

  const stsc = find('stsc');
  if (!stsc) throw new Mp4Error('stsc missing');
  const scN = dv.getUint32(stsc.payload + 4);
  const firstChunk: number[] = [];
  const perChunk: number[] = [];
  for (let i = 0; i < scN; i++) {
    firstChunk.push(dv.getUint32(stsc.payload + 8 + i * 12) - 1);
    perChunk.push(dv.getUint32(stsc.payload + 12 + i * 12));
  }
  const offsets = new Float64Array(count);
  let s = 0;
  for (let e = 0; e < scN && s < count; e++) {
    const lastChunk = e + 1 < scN ? firstChunk[e + 1] : chunkOffsets.length;
    for (let c = firstChunk[e]; c < lastChunk && s < count; c++) {
      let off = chunkOffsets[c];
      for (let k = 0; k < perChunk[e] && s < count; k++, s++) {
        offsets[s] = off;
        off += sizes[s];
      }
    }
  }

  return { count, offsets, sizes, dts, cto, durations, sync };
}

// ---------------------------------------------------------------- sidx ----

/** Parse a sidx box. `boxFileOffset` is where the box starts in the file. */
export function parseSidx(sidxBytes: Uint8Array, boxFileOffset: number): SidxSegment[] {
  const dv = dataView(sidxBytes);
  const box = readBoxHeader(dv, 0);
  if (!box || box.type !== 'sidx') throw new Mp4Error('Expected sidx box');
  let at = box.payload;
  const version = dv.getUint8(at);
  at += 4;
  at += 4; // reference_ID
  const timescale = dv.getUint32(at);
  at += 4;
  let ept: number;
  let firstOffset: number;
  if (version === 0) {
    ept = dv.getUint32(at);
    firstOffset = dv.getUint32(at + 4);
    at += 8;
  } else {
    ept = u64(dv, at);
    firstOffset = u64(dv, at + 8);
    at += 16;
  }
  at += 2; // reserved
  const n = dv.getUint16(at);
  at += 2;

  const segments: SidxSegment[] = [];
  let offset = boxFileOffset + (box.end - box.start) + firstOffset;
  let time = ept;
  for (let i = 0; i < n; i++) {
    const ref = dv.getUint32(at);
    const dur = dv.getUint32(at + 4);
    at += 12;
    const size = ref & 0x7fffffff;
    if (ref >>> 31) throw new Mp4Error('Hierarchical sidx not supported');
    segments.push({
      start: offset,
      end: offset + size,
      startSec: time / timescale,
      durationSec: dur / timescale,
    });
    offset += size;
    time += dur;
  }
  return segments;
}

// ---------------------------------------------------------- moof/mdat ----

/**
 * Parse every moof in `data` (which starts at absolute file offset `fileOffset`)
 * and return the samples belonging to `track`, in decode order.
 */
export function parseFragments(data: Uint8Array, fileOffset: number, track: TrackInit): RawSample[] {
  const dv = dataView(data);
  const out: RawSample[] = [];
  for (const top of children(dv, 0, data.byteLength)) {
    if (top.type !== 'moof') continue;
    const moofAbs = fileOffset + top.start;
    for (const traf of children(dv, top.payload, top.end)) {
      if (traf.type !== 'traf') continue;
      parseTraf(dv, traf, moofAbs, track, out);
    }
  }
  return out;
}

function parseTraf(dv: DataView, traf: BoxRef, moofAbs: number, track: TrackInit, out: RawSample[]) {
  const kids = children(dv, traf.payload, traf.end);
  const tfhd = kids.find((b) => b.type === 'tfhd');
  if (!tfhd) return;
  const tfFlags = dv.getUint32(tfhd.payload) & 0xffffff;
  let at = tfhd.payload + 4;
  const trackId = dv.getUint32(at);
  at += 4;
  if (trackId !== track.id) return;

  let baseOffset = moofAbs;
  if (tfFlags & 0x01) {
    baseOffset = u64(dv, at);
    at += 8;
  }
  if (tfFlags & 0x02) at += 4;
  let defDuration = track.trex?.duration ?? 0;
  let defSize = track.trex?.size ?? 0;
  let defFlags = track.trex?.flags ?? 0;
  if (tfFlags & 0x08) {
    defDuration = dv.getUint32(at);
    at += 4;
  }
  if (tfFlags & 0x10) {
    defSize = dv.getUint32(at);
    at += 4;
  }
  if (tfFlags & 0x20) {
    defFlags = dv.getUint32(at);
    at += 4;
  }

  let decodeTime = 0;
  const tfdt = kids.find((b) => b.type === 'tfdt');
  if (tfdt) {
    const v = dv.getUint8(tfdt.payload);
    decodeTime = v === 1 ? u64(dv, tfdt.payload + 4) : dv.getUint32(tfdt.payload + 4);
  }

  let dataCursor = baseOffset;
  for (const trun of kids) {
    if (trun.type !== 'trun') continue;
    const vf = dv.getUint32(trun.payload);
    const flags = vf & 0xffffff;
    let p = trun.payload + 4;
    const n = dv.getUint32(p);
    p += 4;
    if (flags & 0x01) {
      dataCursor = baseOffset + dv.getInt32(p);
      p += 4;
    }
    let firstFlags: number | null = null;
    if (flags & 0x04) {
      firstFlags = dv.getUint32(p);
      p += 4;
    }
    for (let i = 0; i < n; i++) {
      let duration = defDuration;
      let size = defSize;
      let sFlags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
      let cto = 0;
      if (flags & 0x100) {
        duration = dv.getUint32(p);
        p += 4;
      }
      if (flags & 0x200) {
        size = dv.getUint32(p);
        p += 4;
      }
      if (flags & 0x400) {
        sFlags = dv.getUint32(p);
        p += 4;
      }
      if (flags & 0x800) {
        cto = dv.getInt32(p);
        p += 4;
      }
      const nonSync = (sFlags >> 16) & 1;
      out.push({
        offset: dataCursor,
        size,
        dts: decodeTime,
        cto,
        duration,
        key: track.kind === 'audio' || !nonSync,
      });
      dataCursor += size;
      decodeTime += duration;
    }
  }
}
