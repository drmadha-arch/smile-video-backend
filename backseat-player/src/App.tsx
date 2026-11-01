import { useCallback, useEffect, useRef, useState } from 'react';
import { PlayerView } from './components/PlayerView';
import { SearchBar } from './components/SearchBar';
import { SettingsSheet } from './components/SettingsSheet';
import { GridSkeleton, VideoGrid } from './components/VideoGrid';
import { SettingsIcon } from './components/Icons';
import { history, useHistory } from './lib/history';
import { settings, useSettings } from './lib/settings';
import { playback, usePlayback } from './playback';
import { webCodecsSupported } from './player/engine';
import { searchVideos, trending, type SearchPage, type VideoItem } from './youtube/dataApi';
import { parseVideoInput } from './youtube/parse';

type Tab = 'trending' | 'search' | 'recent';

interface Feed {
  items: VideoItem[];
  next?: string;
  loading: boolean;
  error?: string;
}

const emptyFeed: Feed = { items: [], loading: false };

export default function App() {
  const s = useSettings();
  const pb = usePlayback();
  const hist = useHistory();
  const hasKey = !!settings.apiKey();
  const [tab, setTab] = useState<Tab>(hist.length && !hasKey ? 'recent' : 'trending');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Feed>(emptyFeed);
  const [trend, setTrend] = useState<Feed>(emptyFeed);
  const [expanded, setExpanded] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const supported = webCodecsSupported();

  const load = useCallback(
    async (kind: 'search' | 'trending', q: string, page?: string) => {
      const set = kind === 'search' ? setResults : setTrend;
      set((f) => ({ ...f, loading: true, error: undefined, items: page ? f.items : [] }));
      try {
        const res: SearchPage = kind === 'search' ? await searchVideos(q, page) : await trending(page);
        set((f) => ({
          items: page ? dedupe([...f.items, ...res.items]) : res.items,
          next: res.nextPageToken,
          loading: false,
        }));
      } catch (e) {
        set((f) => ({ ...f, loading: false, error: (e as Error).message }));
      }
    },
    [],
  );

  // Load trending once per (key, region); a ref guards against StrictMode double-runs.
  const trendKey = useRef('');
  useEffect(() => {
    const k = `${settings.apiKey()}|${s.region}`;
    if (tab !== 'trending' || !hasKey || trendKey.current === k) return;
    trendKey.current = k;
    void load('trending', '');
  }, [tab, hasKey, s.apiKey, s.region, load]);

  const play = (v: Partial<VideoItem> & { id: string }, start?: number) => {
    setExpanded(true);
    void playback.playYouTube(v, start);
  };

  const submit = (text: string) => {
    const parsed = parseVideoInput(text);
    if (parsed?.kind === 'youtube') return play({ id: parsed.id }, parsed.start);
    if (parsed?.kind === 'direct') {
      setExpanded(true);
      return void playback.playDirect(parsed.url);
    }
    setQuery(text);
    setTab('search');
    void load('search', text);
  };

  const recentItems: VideoItem[] = hist.map((h) => ({
    id: h.id,
    title: h.title,
    channel: h.channel ?? '',
    thumbnail: h.thumbnail ?? `https://i.ytimg.com/vi/${h.id}/hqdefault.jpg`,
    durationSec: h.durationSec,
  }));

  const feed = tab === 'search' ? results : trend;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line/60 bg-bg/95 px-6 py-4 backdrop-blur">
        <div className="flex shrink-0 items-center gap-3 pr-2">
          <img src="/icon.svg" alt="" className="h-11 w-11" />
          <span className="hidden text-2xl font-bold tracking-tight md:block">Backseat</span>
        </div>
        <SearchBar onSubmit={submit} />
        <button
          aria-label="Settings"
          onClick={() => setShowSettings(true)}
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-surface-2 active:scale-95"
        >
          <SettingsIcon size={30} />
        </button>
      </header>

      <main className="no-scrollbar flex-1 overflow-y-auto px-6 pb-40 pt-5">
        {!supported && (
          <Notice title="This browser can't run the player">
            Needs WebCodecs over HTTPS. Open this site via its <b>https://</b> address in the Tesla browser (or any
            recent Chrome/Edge).
          </Notice>
        )}

        <nav className="mb-6 flex gap-3">
          <TabButton active={tab === 'trending'} onClick={() => setTab('trending')}>
            Trending
          </TabButton>
          {query && (
            <TabButton active={tab === 'search'} onClick={() => setTab('search')}>
              “{query.length > 24 ? query.slice(0, 24) + '…' : query}”
            </TabButton>
          )}
          <TabButton active={tab === 'recent'} onClick={() => setTab('recent')}>
            Recent{hist.length ? ` (${hist.length})` : ''}
          </TabButton>
        </nav>

        {tab === 'recent' ? (
          recentItems.length ? (
            <VideoGrid
              items={recentItems}
              onPlay={(v) => play(v)}
              onRemove={(v) => history.remove(v.id)}
            />
          ) : (
            <Empty>Nothing here yet. Videos you play show up here, and resume where you left off.</Empty>
          )
        ) : !hasKey ? (
          <Notice title="Add a YouTube API key to search">
            Set <code>VITE_YOUTUBE_API_KEY</code> at build time, or enter a key in{' '}
            <button className="font-semibold text-accent-2 underline" onClick={() => setShowSettings(true)}>
              Settings
            </button>
            . Pasting a YouTube link or video ID into the box above works without a key.
          </Notice>
        ) : (
          <>
            {feed.error && (
              <Notice title="Couldn't load videos">
                {feed.error}{' '}
                <button
                  className="font-semibold text-accent-2 underline"
                  onClick={() => void load(tab === 'search' ? 'search' : 'trending', query)}
                >
                  Try again
                </button>
              </Notice>
            )}
            {feed.items.length > 0 && <VideoGrid items={feed.items} onPlay={(v) => play(v)} />}
            {feed.loading && <div className={feed.items.length ? 'mt-7' : ''}><GridSkeleton /></div>}
            {!feed.loading && feed.next && (
              <div className="mt-10 flex justify-center">
                <button
                  onClick={() => void load(tab === 'search' ? 'search' : 'trending', query, feed.next)}
                  className="h-16 rounded-full bg-surface-2 px-10 text-xl font-semibold active:scale-95"
                >
                  Load more
                </button>
              </div>
            )}
            {!feed.loading && !feed.error && !feed.items.length && tab === 'search' && <Empty>No results.</Empty>}
          </>
        )}
      </main>

      {pb.item && (
        <PlayerView expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
      )}
      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function dedupe(items: VideoItem[]) {
  const seen = new Set<string>();
  return items.filter((v) => !seen.has(v.id) && seen.add(v.id));
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-14 rounded-full px-7 text-lg font-semibold active:scale-95 ${
        active ? 'bg-white text-black' : 'bg-surface-2 text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-2xl bg-surface-2 p-6 ring-1 ring-line">
      <div className="mb-1 text-xl font-semibold">{title}</div>
      <div className="text-lg text-muted">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-24 text-center text-xl text-muted">{children}</div>;
}
