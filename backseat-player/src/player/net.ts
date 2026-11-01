/**
 * Network layer tuned for a moving car on LTE:
 *  - Stall watchdog instead of a hard timeout: slow-but-progressing downloads
 *    are allowed to finish, dead sockets get killed fast.
 *  - Waits for `online` instead of hammering when the car is in a tunnel.
 *  - 401/403/404/410 surface as UrlExpiredError so the engine can re-resolve
 *    the stream URL (YouTube URLs expire after a few hours).
 */

export class UrlExpiredError extends Error {
  constructor(public status: number) {
    super(`Stream URL rejected (HTTP ${status})`);
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const isAbort = (e: unknown) =>
  e instanceof DOMException ? e.name === 'AbortError' : (e as Error)?.name === 'AbortError';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolve once the browser reports it is online (or after maxWaitMs). */
export function waitForOnline(maxWaitMs: number, signal?: AbortSignal): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      window.removeEventListener('online', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, maxWaitMs);
    window.addEventListener('online', done);
    signal?.addEventListener('abort', done);
  });
}

/** Exponentially weighted throughput estimate shared by all fetchers. */
class BandwidthEstimator {
  private bps = 0;
  sample(bytes: number, ms: number) {
    if (bytes < 64 * 1024 || ms <= 0) return;
    const v = (bytes * 8 * 1000) / ms;
    this.bps = this.bps === 0 ? v : this.bps * 0.7 + v * 0.3;
  }
  get bitsPerSecond() {
    return this.bps;
  }
}
export const bandwidth = new BandwidthEstimator();

export interface FetcherOptions {
  /** Abort if no bytes arrive for this long. */
  stallTimeoutMs?: number;
  /** Quick in-place retries for transient failures before giving up. */
  attempts?: number;
}

/** Fetches byte ranges from a single (swappable) URL. */
export class RangeFetcher {
  totalSize: number | undefined;
  private stallTimeoutMs: number;
  private attempts: number;

  private _url = '';
  private queryRange = false;

  get url() {
    return this._url;
  }

  set url(u: string) {
    this._url = u;
    this.queryRange = u.includes('/videoplayback');
  }

  constructor(url: string, totalSize?: number, opts: FetcherOptions = {}) {
    this.url = url;
    this.totalSize = totalSize;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 10_000;
    this.attempts = opts.attempts ?? 3;
  }

  /** Read bytes [start, end). */
  async read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.totalSize !== undefined) end = Math.min(end, this.totalSize);
    if (end <= start) return new Uint8Array(0);
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        await waitForOnline(15_000, signal);
        return await this.readOnce(start, end, signal);
      } catch (e) {
        if (isAbort(e) && signal?.aborted) throw e;
        if (e instanceof UrlExpiredError) throw e;
        if (e instanceof HttpError && e.status === 416) throw e;
        lastErr = e;
        // Proxy ignored ?range=: retry right away using the Range header.
        if (e instanceof HttpError && e.status === 200 && !this.queryRange && attempt === 0) continue;
        await sleep(400 * 2 ** attempt + Math.random() * 300, signal);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async readOnce(start: number, end: number, outer?: AbortSignal): Promise<Uint8Array> {
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort();
    outer?.addEventListener('abort', onOuter, { once: true });
    let stallTimer = setTimeout(() => ctrl.abort(), this.stallTimeoutMs);
    const kick = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ctrl.abort(), this.stallTimeoutMs);
    };
    const t0 = performance.now();
    try {
      const rangeVal = `${start}-${end - 1}`;
      let url = this.url;
      const init: RequestInit = { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' };
      if (this.queryRange) {
        // googlevideo and the Invidious/Piped proxies take the range as a query
        // param. No custom header = no CORS preflight = one less round trip.
        const u = new URL(url, location.href);
        u.searchParams.set('range', rangeVal);
        url = u.toString();
      } else {
        init.headers = { Range: `bytes=${rangeVal}` };
      }
      const res = await fetch(url, init);
      kick();
      if ([401, 403, 404, 410].includes(res.status)) throw new UrlExpiredError(res.status);
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);

      const cr = res.headers.get('content-range');
      if (cr) {
        const total = /\/(\d+)\s*$/.exec(cr);
        if (total) this.totalSize = Number(total[1]);
      }
      const want = end - start;
      const lenHeader = Number(res.headers.get('content-length') || 0);
      let sliceFrom = 0;
      if (res.status === 200 && lenHeader && lenHeader !== want) {
        if (this.queryRange) {
          // This proxy ignored ?range=. Don't download the file; switch to the header.
          void res.body?.cancel();
          this.queryRange = false;
          throw new HttpError(200, 'range param ignored, retrying with Range header');
        }
        // Server ignored the Range header too and is sending the whole file.
        if (lenHeader > 32 * 1024 * 1024) throw new HttpError(200, 'Server does not support range requests');
        this.totalSize = lenHeader;
        sliceFrom = start;
      }

      const body = await this.readBody(res, kick);
      bandwidth.sample(body.byteLength, performance.now() - t0);
      if (sliceFrom || body.byteLength > want) {
        return body.subarray(sliceFrom, sliceFrom + want);
      }
      if (body.byteLength < want && (this.totalSize === undefined || start + body.byteLength < this.totalSize)) {
        throw new HttpError(res.status, `Short read (${body.byteLength}/${want})`);
      }
      return body;
    } finally {
      clearTimeout(stallTimer);
      outer?.removeEventListener('abort', onOuter);
    }
  }

  private async readBody(res: Response, kick: () => void): Promise<Uint8Array> {
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      parts.push(value);
      total += value.byteLength;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }
}

/**
 * Chunk-aligned cache over a fetcher. Used for muxed progressive files so the
 * audio and video tracks (interleaved in the same byte ranges) share downloads.
 */
export class ChunkCache {
  private chunks = new Map<number, Promise<Uint8Array>>();

  constructor(
    readonly fetcher: RangeFetcher,
    private chunkSize = 512 * 1024,
    private maxChunks = 48,
  ) {}

  async read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    const first = Math.floor(start / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) => this.chunk(first + i, signal)),
    );
    const out = new Uint8Array(end - start);
    for (let i = 0; i < parts.length; i++) {
      const chunkStart = (first + i) * this.chunkSize;
      const from = Math.max(start, chunkStart) - chunkStart;
      const to = Math.min(end, chunkStart + parts[i].byteLength) - chunkStart;
      if (to > from) out.set(parts[i].subarray(from, to), chunkStart + from - start);
    }
    return out;
  }

  private chunk(i: number, signal?: AbortSignal): Promise<Uint8Array> {
    const hit = this.chunks.get(i);
    if (hit) {
      // refresh LRU position
      this.chunks.delete(i);
      this.chunks.set(i, hit);
      return hit;
    }
    // Chunk downloads are shared, so they must not be cancelled by one caller.
    void signal;
    const p = this.fetcher.read(i * this.chunkSize, (i + 1) * this.chunkSize);
    p.catch(() => this.chunks.delete(i));
    this.chunks.set(i, p);
    while (this.chunks.size > this.maxChunks) {
      const oldest = this.chunks.keys().next().value as number;
      this.chunks.delete(oldest);
    }
    return p;
  }

  clear() {
    this.chunks.clear();
  }
}
