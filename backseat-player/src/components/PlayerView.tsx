import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTime } from '../lib/format';
import { settings, useSettings, type QualityPref } from '../lib/settings';
import { engine, playback, usePlayback, usePlayerSnapshot } from '../playback';
import {
  Back10Icon,
  ChevronDownIcon,
  CloseIcon,
  ExitFullscreenIcon,
  ExpandIcon,
  Fwd10Icon,
  FullscreenIcon,
  HdIcon,
  InfoIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  ReplayIcon,
  Spinner,
  VolumeIcon,
} from './Icons';
import { Slider } from './Slider';

interface Props {
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}

const HIDE_AFTER_MS = 4000;

export function PlayerView({ expanded, onExpand, onCollapse }: Props) {
  const snap = usePlayerSnapshot();
  const pb = usePlayback();
  const s = useSettings();
  const [controls, setControls] = useState(true);
  const [scrub, setScrub] = useState<number | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const hideTimer = useRef(0);
  const lastTap = useRef<{ t: number; zone: number }>({ t: 0, zone: -1 });

  const canvasRef = useCallback((el: HTMLCanvasElement | null) => {
    if (el) engine.attachCanvas(el);
  }, []);

  const playing = snap.state === 'playing' || snap.state === 'buffering';
  const busy = !!pb.status || snap.state === 'loading' || snap.state === 'buffering';
  const error = pb.error ?? snap.error;
  const showPoster = !!pb.status || snap.state === 'loading' || snap.state === 'idle';

  const poke = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (engine.getSnapshot().state === 'playing') {
        setControls(false);
        setQualityOpen(false);
      }
    }, HIDE_AFTER_MS);
  }, []);

  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, [poke, snap.state]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Desktop conveniences (handy while testing on a laptop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        engine.toggle();
      } else if (e.key === 'ArrowLeft') engine.seekBy(-10);
      else if (e.key === 'ArrowRight') engine.seekBy(10);
      else if (e.key === 'm') engine.setMuted(!engine.getSnapshot().muted);
      else return;
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [poke]);

  const onSurfaceTap = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!expanded) return onExpand();
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const zone = x < 0.33 ? 0 : x > 0.67 ? 2 : 1;
    const now = performance.now();
    const isDouble = now - lastTap.current.t < 320 && lastTap.current.zone === zone;
    lastTap.current = { t: now, zone };
    if (isDouble && zone !== 1) {
      engine.seekBy(zone === 0 ? -10 : 10);
      poke();
      return;
    }
    if (controls && !isDouble) {
      setControls(false);
      setQualityOpen(false);
    } else poke();
  };

  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const progress = snap.duration ? (scrub ?? snap.currentTime) / snap.duration : 0;
  const buffered = snap.duration ? (snap.currentTime + snap.bufferedAhead) / snap.duration : 0;
  const title = pb.item?.title ?? '';

  const container = expanded
    ? 'fixed inset-0 z-40 bg-black'
    : 'fixed bottom-5 right-5 z-40 aspect-video w-[min(34vw,460px)] overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/70 ring-1 ring-white/10';

  return (
    <div className={container}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {showPoster && pb.item?.thumbnail && (
        <img
          src={pb.item.thumbnail}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-40 blur-sm"
          referrerPolicy="no-referrer"
        />
      )}

      {/* Tap surface */}
      <div className="absolute inset-0" onPointerUp={onSurfaceTap} />

      {/* Center status */}
      {!error && busy && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-5 text-white">
          <Spinner size={expanded ? 72 : 44} />
          {expanded && (pb.status || snap.message) && (
            <div className="rounded-full bg-black/60 px-5 py-2 text-lg">{pb.status ?? snap.message}</div>
          )}
        </div>
      )}
      {!error && !busy && snap.message && expanded && (
        <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 rounded-full bg-black/70 px-5 py-2 text-lg">
          {snap.message}
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6">
          <div className="max-w-xl text-center">
            <div className="mb-2 text-2xl font-semibold">{error}</div>
            {expanded && pb.errorDetails.length > 0 && (
              <ul className="no-scrollbar mx-auto mb-6 max-h-40 overflow-y-auto text-left text-sm text-muted">
                {pb.errorDetails.map((d, i) => (
                  <li key={i} className="truncate">
                    • {d}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-center gap-4">
              <button
                className="h-14 rounded-full bg-accent px-8 text-lg font-semibold active:scale-95"
                onClick={() => void playback.retry()}
              >
                Retry
              </button>
              <button
                className="h-14 rounded-full bg-surface-2 px-8 text-lg font-semibold active:scale-95"
                onClick={() => playback.close()}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mini player controls */}
      {!expanded && !error && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/90 to-transparent p-2 pt-8">
          <button
            className="flex h-14 w-14 items-center justify-center rounded-full active:bg-white/15"
            onClick={() => engine.toggle()}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseIcon size={32} /> : <PlayIcon size={32} />}
          </button>
          <div className="mx-2 min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
          <button
            className="flex h-14 w-14 items-center justify-center rounded-full active:bg-white/15"
            onClick={onExpand}
            aria-label="Expand"
          >
            <ExpandIcon size={26} />
          </button>
          <button
            className="flex h-14 w-14 items-center justify-center rounded-full active:bg-white/15"
            onClick={() => playback.close()}
            aria-label="Close player"
          >
            <CloseIcon size={26} />
          </button>
        </div>
      )}
      {!expanded && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
          <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      {/* Full controls */}
      {expanded && !error && (
        <div
          className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${
            controls || !playing ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/85 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/90 to-transparent" />

          {/* Top bar */}
          <div className={`absolute inset-x-0 top-0 flex items-center gap-3 p-4 ${controls || !playing ? 'pointer-events-auto' : ''}`}>
            <IconButton label="Minimize" onClick={onCollapse}>
              <ChevronDownIcon size={34} />
            </IconButton>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xl font-semibold">{title}</div>
              {pb.item?.channel && <div className="truncate text-muted">{pb.item.channel}</div>}
            </div>
            <IconButton label="Stats" active={s.showStats} onClick={() => settings.update({ showStats: !s.showStats })}>
              <InfoIcon size={28} />
            </IconButton>
            {pb.mode && (pb.heights.length > 0 || pb.currentHeight) && (
              <div className="relative">
                <button
                  className="flex h-14 items-center gap-2 rounded-full bg-white/10 px-4 text-lg font-semibold active:bg-white/25"
                  onClick={() => {
                    setQualityOpen((o) => !o);
                    poke();
                  }}
                >
                  <HdIcon size={26} />
                  {s.quality === 'auto' ? `Auto · ${pb.currentHeight ?? '–'}p` : `${pb.currentHeight ?? s.quality}p`}
                </button>
                {qualityOpen && (
                  <QualityMenu
                    heights={pb.heights}
                    current={s.quality}
                    onPick={(q) => {
                      setQualityOpen(false);
                      void playback.setQuality(q);
                      poke();
                    }}
                  />
                )}
              </div>
            )}
            <IconButton label="Close player" onClick={() => playback.close()}>
              <CloseIcon size={30} />
            </IconButton>
          </div>

          {/* Center transport */}
          <div
            className={`absolute inset-0 m-auto flex h-32 items-center justify-center gap-14 ${
              controls || !playing ? 'pointer-events-auto' : ''
            } w-fit`}
          >
            <button
              className="flex h-24 w-24 items-center justify-center rounded-full bg-black/40 active:scale-95 active:bg-white/20"
              onClick={() => {
                engine.seekBy(-10);
                poke();
              }}
              aria-label="Back 10 seconds"
            >
              <Back10Icon size={52} />
            </button>
            <button
              className={`flex h-32 w-32 items-center justify-center rounded-full bg-black/50 active:scale-95 active:bg-white/20 ${
                busy ? 'opacity-0' : ''
              }`}
              onClick={() => {
                engine.toggle();
                poke();
              }}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {snap.state === 'ended' ? (
                <ReplayIcon size={64} />
              ) : playing ? (
                <PauseIcon size={68} />
              ) : (
                <PlayIcon size={68} />
              )}
            </button>
            <button
              className="flex h-24 w-24 items-center justify-center rounded-full bg-black/40 active:scale-95 active:bg-white/20"
              onClick={() => {
                engine.seekBy(10);
                poke();
              }}
              aria-label="Forward 10 seconds"
            >
              <Fwd10Icon size={52} />
            </button>
          </div>

          {/* Bottom bar */}
          <div className={`absolute inset-x-0 bottom-0 px-6 pb-4 ${controls || !playing ? 'pointer-events-auto' : ''}`}>
            <div className="flex items-center gap-4">
              <span className="w-24 text-right text-lg tabular-nums">{formatTime(scrub ?? snap.currentTime)}</span>
              <Slider
                className="flex-1"
                label="Seek"
                value={progress}
                secondary={buffered}
                onDragChange={(d, v) => {
                  setScrub(d ? v * snap.duration : null);
                  poke();
                }}
                onCommit={(v) => engine.seek(v * snap.duration)}
              />
              <span className="w-24 text-lg tabular-nums text-muted">{formatTime(snap.duration)}</span>
            </div>
            <div className="flex items-center gap-3">
              <IconButton label={snap.muted ? 'Unmute' : 'Mute'} onClick={() => engine.setMuted(!snap.muted)}>
                {snap.muted || snap.volume === 0 ? <MuteIcon size={30} /> : <VolumeIcon size={30} />}
              </IconButton>
              <Slider
                className="w-56"
                label="Volume"
                value={snap.muted ? 0 : snap.volume}
                onChange={(v) => {
                  engine.setVolume(v);
                  poke();
                }}
                onCommit={(v) => settings.update({ volume: v })}
              />
              <div className="flex-1" />
              {pb.sourceHost && <span className="text-sm text-muted">via {pb.sourceHost}</span>}
              {document.fullscreenEnabled && (
                <IconButton label="Fullscreen" onClick={toggleFs}>
                  {isFs ? <ExitFullscreenIcon size={30} /> : <FullscreenIcon size={30} />}
                </IconButton>
              )}
            </div>
          </div>
        </div>
      )}

      {expanded && s.showStats && <StatsPanel />}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full active:scale-95 active:bg-white/25 ${
        active ? 'bg-white/20' : 'bg-white/0'
      }`}
    >
      {children}
    </button>
  );
}

function QualityMenu({
  heights,
  current,
  onPick,
}: {
  heights: number[];
  current: QualityPref;
  onPick: (q: QualityPref) => void;
}) {
  const opts: QualityPref[] = ['auto', ...(heights.filter((h) => [1080, 720, 480, 360].includes(h)) as QualityPref[])];
  return (
    <div className="absolute right-0 top-16 z-10 w-56 overflow-hidden rounded-2xl bg-surface-2 py-2 shadow-2xl ring-1 ring-white/10">
      {opts.map((q) => (
        <button
          key={q}
          onClick={() => onPick(q)}
          className={`flex h-14 w-full items-center px-5 text-left text-lg active:bg-white/15 ${
            q === current ? 'font-semibold text-accent-2' : ''
          }`}
        >
          {q === 'auto' ? 'Auto (≤720p)' : `${q}p`}
        </button>
      ))}
      {heights.length === 0 && <div className="px-5 py-3 text-sm text-muted">Compatibility stream (fixed quality)</div>}
    </div>
  );
}

function StatsPanel() {
  const snap = usePlayerSnapshot();
  const pb = usePlayback();
  const st = snap.stats;
  const rows: [string, string][] = [
    ['State', snap.state],
    ['Mode', pb.mode ?? '–'],
    ['Video', `${st.width}×${st.height} ${st.videoCodec}`],
    ['Audio', st.audioCodec || '–'],
    ['Decoder', st.decoderMode],
    ['Buffer', `V ${st.videoBufferSec.toFixed(1)}s · A ${st.audioBufferSec.toFixed(1)}s`],
    ['Network', st.bandwidthKbps ? `${(st.bandwidthKbps / 1000).toFixed(1)} Mbps` : '–'],
    ['Frames', `${st.decodedFrames} decoded · ${st.droppedFrames} dropped`],
    ['Stalls', String(st.stalls)],
    ['Source', pb.sourceHost ?? '–'],
  ];
  return (
    <div className="pointer-events-none absolute left-4 top-24 rounded-xl bg-black/75 p-4 font-mono text-sm leading-6">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span className="inline-block w-24 text-muted">{k}</span>
          {v}
        </div>
      ))}
    </div>
  );
}
