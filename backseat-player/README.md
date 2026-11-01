# Backseat

A self-hosted YouTube player built for the Tesla in-car browser. Video is decoded with **WebCodecs** and drawn to a **`<canvas>`**, and audio plays through **Web Audio**. No `<video>` element is involved, so playback keeps going after the car leaves Park (for passengers).

- Search and Trending through the official **YouTube Data API v3**
- Paste any YouTube link (watch, youtu.be, shorts, embed, live, music, with `?t=`) or a bare video ID
- Streams resolved through **Invidious / Piped**, with automatic failover between instances
- Dark, touch-first UI: 56px+ hit targets, double-tap left/right to skip 10s, auto-hiding controls, and a mini player so you can keep browsing
- Remembers where you stopped in every video

---

## 1. Run locally

```bash
cd backseat-player
npm install
cp .env.example .env        # then put your API key in .env
npm run dev                 # http://localhost:5173
```

WebCodecs only works in a **secure context**: `https://` or `http://localhost`. If you open the dev server from another device over plain `http://192.168.x.x`, the player is disabled. To test in the car, deploy it (section 4).

### Test the player without YouTube

```bash
npm run test:media          # needs ffmpeg; writes public/test-media/ (git-ignored)
```

Then paste `http://localhost:5173/test-media/muxed.mp4` into the search box. Any CORS-enabled `.mp4` URL works the same way, so you can check the playback engine on its own, separately from the stream sources.

---

## 2. YouTube API key (`VITE_YOUTUBE_API_KEY`)

1. Go to <https://console.cloud.google.com>, create a project, then go to **APIs & Services → Library** and enable **YouTube Data API v3**.
2. **Credentials → Create credentials → API key.**
3. **Restrict the key.** This step matters: the key ends up in the JavaScript bundle, and anyone who opens your site can read it.
   - *Application restrictions:* **Websites**, add `https://your-domain.com/*` (and `http://localhost:5173/*` for dev).
   - *API restrictions:* **YouTube Data API v3** only.
4. Put it in `.env` as `VITE_YOUTUBE_API_KEY=...`, or paste it at runtime under **Settings → YouTube API key**. The runtime value is stored in the browser and overrides the built-in one.

**Quota:** you get 10,000 units/day. A search costs 101 units (`search.list` + `videos.list`), so that's roughly **95 searches a day**. Trending and pasted links cost about 1 unit each. Results are cached for 30 minutes. Pasting a link never uses the API at all.

---

## 3. Stream sources (read this before you blame the player)

Browsers can't fetch `googlevideo.com` directly. The URLs are IP-locked, signature-protected and have no CORS headers. So something has to extract the stream URLs **and proxy the bytes** with CORS. That's the job of Invidious (`?local=true`) or Piped.

**Public instances are the weakest link in this whole setup.** YouTube actively blocks them, many have the video proxy turned off, and they come and go. The defaults in `.env.example` were working at some point; there's no guarantee they still do.

What actually works reliably:

| Option | Reliability | Notes |
|---|---|---|
| **Self-hosted Invidious + invidious-companion** on a home server / NAS / Raspberry Pi | Best | Residential IPs are rarely blocked. Expose it over HTTPS (Cloudflare Tunnel or Tailscale Funnel both work). |
| Self-hosted Piped | Good | More moving parts (backend + proxy). |
| A VPS | Mixed | Datacenter IPs often get "confirm you're not a bot". |
| Public instances | Poor | Fine to try. Don't depend on them. |

Configure them, in priority order:

```bash
VITE_INVIDIOUS_INSTANCES=https://invidious.my-home.example,https://inv.nadeko.net
VITE_PIPED_INSTANCES=https://pipedapi.kavin.rocks
```

You can also change them at runtime under **Settings → Stream sources**, then press **Test sources** to check each one end to end. That's useful because you can fix a dead instance from the car without redeploying. Requirements for your own instance:

- It must be **HTTPS** (mixed content is blocked).
- For Invidious, `local=true` proxying must be enabled. That's the default, unless `disable_proxy` is set in `config.yml`.
- `/api/v1/*` and `/videoplayback` must send `Access-Control-Allow-Origin: *`. Invidious and Piped do this out of the box.

The app remembers the last instance that worked and tries it first. If one fails, it moves to the next. If a stream URL expires mid-video (they last about 6 hours), the player re-resolves it in the background and keeps playing.

---

## 4. Deploy

Your environment variables are baked in **at build time**, so after changing them you need to redeploy.

### Vercel

1. Push the repo to GitHub, then **New Project → Import** it on <https://vercel.com>.
2. **Root Directory:** `backseat-player` (the app lives in a subfolder of this repo).
3. The framework preset (Vite), build command and output directory are picked up from `vercel.json`.
4. **Environment Variables:** add `VITE_YOUTUBE_API_KEY` (plus the optional instance lists).
5. Deploy. Then add the `*.vercel.app` domain (or your own) to the API key's referrer restrictions.

### Cloudflare Pages

1. **Workers & Pages → Create → Pages → Connect to Git**, then pick the repo.
2. Framework preset **Vite**. Build command `npm run build`. Output directory `dist`. **Root directory `backseat-player`**.
3. Add the same environment variables under *Settings → Environment variables (Production)*.
4. Deploy, then add `https://<project>.pages.dev/*` to the API key's referrer list.

Either way, you get a static site of about 95 KB gzipped JS. There's no server to maintain.

---

## 5. Using it in the Tesla

1. Open the deployed `https://` URL in the car's browser and add it to favorites.
2. Tap a video. The player opens full screen. Tap anywhere to show or hide the controls. Double-tap the left or right third to skip back or ahead 10s.
3. Tap **⌄** to shrink it to a mini player while you browse, and **⤢** to bring it back.
4. Volume: the in-app slider is the media volume. The car's scroll wheel still controls the master volume.
5. **ⓘ** shows live stats (resolution, decoder, buffer, bandwidth, stalls). Turn it on first if something misbehaves.

**Quality:** *Auto* starts at 720p, drops a step after repeated stalls, and steps back up only after 90 calm seconds with plenty of bandwidth. It never goes above 720p on its own. That's plenty for the car's screen and easier on LTE data. You can pick 1080p manually.

**Buffer:** by default the player downloads 60s ahead. If your route has dead zones, set **Settings → Buffer ahead** to 2–4 minutes.

---

## How it works

```
src/
  player/            # the engine: no React, no YouTube
    mp4.ts           # ISO-BMFF parser: moov/avcC/esds, sidx, moof/trun, stbl sample tables
    net.ts           # range fetcher: stall watchdog, offline wait, expiry detection, bandwidth EWMA
    tracks.ts        # tracks as keyframe-aligned segments (DASH via sidx, progressive via stbl)
    pipelines.ts     # fetch-ahead + VideoDecoder→frame queue, AudioDecoder→Web Audio scheduling
    engine.ts        # clock, buffering state machine, seek, recovery, canvas rendering
  youtube/
    dataApi.ts       # Data API v3: search, trending, video details (+ caching)
    streams.ts       # Invidious / Piped resolution with failover
    parse.ts         # URL / ID parsing
  playback.ts        # glue: format choice, fallbacks, URL refresh, auto quality, resume
  components/        # React UI
```

**Formats.** It plays YouTube's H.264 (`avc1`) DASH video plus AAC (itag 140) DASH audio, up to 1080p. That's the most widely hardware-decoded combination. If that fails, it falls back to the muxed 360p MP4 (itag 18), and then to the next instance.

**A/V sync.** The `AudioContext` is the master clock. Pausing and buffering *suspend* the context, which freezes the clock and every scheduled audio buffer together, so audio and video can't drift apart. Each frame is drawn when the audio clock reaches its timestamp, with output latency compensated.

**Reliability features, all exercised by tests during development:**
- Downloads use a stall watchdog instead of a hard timeout. Slow LTE is fine; a dead socket is retried within 10s.
- Retries never give up while you're moving. When the browser reports offline, the player waits for the network to come back and shows "No signal, waiting for network…".
- Stalls rebuffer with a growing cushion (2s, 4s, 8s, up to 15s), so playback doesn't stutter on and off.
- Expired or 403 stream URLs are re-resolved in place without interrupting playback.
- If the decoder errors out, the player recreates it and moves to software decoding after repeated failures.
- If the decoder falls behind (slow hardware, or the tab was hidden), it jumps to the nearest keyframe instead of drifting further out of sync.
- If the browser blocks autoplay, the player shows a "Tap play" prompt instead of looking frozen.

---

## Limitations

- **H.264/AAC only.** Some videos only have VP9/AV1 above 1080p; you get the best H.264 rendition, which is still up to 1080p. A very small number of videos have no H.264 at all and fall back to 360p.
- **No live streams, no captions, no playlists.**
- **Stream extraction is outside your control.** When YouTube changes something, Invidious and Piped need an update. Self-hosting means you control when that update happens.
- **The API key is public by design** (it's a static site). Lock it down with referrer restrictions as described above.
- **Watching while driving:** use it for passengers only. Tesla blocks `<video>` while moving for a reason.

This is a personal-use project. Using third-party front-ends to watch YouTube may conflict with YouTube's Terms of Service; that's your call.
