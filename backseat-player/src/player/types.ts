export interface EncodedSample {
  data: Uint8Array;
  /** Presentation timestamp, microseconds. */
  ts: number;
  /** Duration, microseconds. */
  dur: number;
  key: boolean;
}

export interface Segment {
  startUs: number;
  endUs: number;
}

export type TrackInfo =
  | { kind: 'video'; codec: string; description?: Uint8Array; width: number; height: number }
  | { kind: 'audio'; codec: string; description?: Uint8Array; sampleRate: number; channels: number };

export interface RemoteFile {
  url: string;
  /** Inclusive byte range of the init segment (moov), if known. */
  initRange?: [number, number];
  /** Inclusive byte range of the sidx box, if known. */
  indexRange?: [number, number];
  contentLength?: number;
}

export type SourceSpec =
  | { type: 'adaptive'; video: RemoteFile; audio?: RemoteFile }
  | { type: 'muxed'; file: RemoteFile };

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export interface PlayerStats {
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  decodedFrames: number;
  droppedFrames: number;
  bandwidthKbps: number;
  stalls: number;
  decoderMode: string;
  videoBufferSec: number;
  audioBufferSec: number;
}

export interface PlayerSnapshot {
  state: PlayerState;
  currentTime: number;
  duration: number;
  /** Seconds of media downloaded ahead of the playhead (min over tracks). */
  bufferedAhead: number;
  volume: number;
  muted: boolean;
  /** Transient status text, e.g. "Reconnecting…". */
  message?: string;
  error?: string;
  stats: PlayerStats;
}

export interface LoadOptions {
  startTime?: number;
  autoplay?: boolean;
  /** Called when URLs are rejected (expired). Must return fresh URLs for the same formats. */
  refresh?: () => Promise<SourceSpec>;
}
