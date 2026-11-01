import { formatTime, formatViews, timeAgo } from '../lib/format';
import { useHistory } from '../lib/history';
import type { VideoItem } from '../youtube/dataApi';

interface Props {
  items: VideoItem[];
  onPlay: (v: VideoItem) => void;
  onRemove?: (v: VideoItem) => void;
}

export function VideoGrid({ items, onPlay, onRemove }: Props) {
  const hist = useHistory();
  const pos = new Map(hist.map((h) => [h.id, h]));
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-7 lg:grid-cols-3 2xl:grid-cols-4">
      {items.map((v) => {
        const h = pos.get(v.id);
        const dur = v.durationSec || h?.durationSec || 0;
        const pct = h && dur ? Math.min(1, h.position / dur) : 0;
        return (
          <button
            key={v.id}
            onClick={() => onPlay(v)}
            className="group text-left transition-transform active:scale-[0.97]"
          >
            <div className="relative aspect-video overflow-hidden rounded-2xl bg-surface-2">
              {v.thumbnail && (
                <img
                  src={v.thumbnail}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              )}
              {dur > 0 && (
                <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-2 py-0.5 text-sm font-semibold tabular-nums">
                  {formatTime(dur)}
                </span>
              )}
              {pct > 0.01 && (
                <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/25">
                  <div className="h-full bg-accent" style={{ width: `${pct * 100}%` }} />
                </div>
              )}
              {onRemove && (
                <span
                  role="button"
                  aria-label="Remove from recent"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(v);
                  }}
                  className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-xl active:bg-white/30"
                >
                  ×
                </span>
              )}
            </div>
            <div className="mt-3 line-clamp-2 text-lg font-semibold leading-snug">{v.title}</div>
            <div className="mt-1 truncate text-muted">
              {[v.channel, formatViews(v.views), timeAgo(v.publishedAt)].filter(Boolean).join(' · ')}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-7 lg:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-video rounded-2xl bg-surface-2" />
          <div className="mt-3 h-5 w-4/5 rounded bg-surface-2" />
          <div className="mt-2 h-4 w-1/2 rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
