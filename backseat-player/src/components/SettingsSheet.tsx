import { useState } from 'react';
import { history } from '../lib/history';
import { envDefaults, parseInstanceList, settings, useSettings, type QualityPref } from '../lib/settings';
import { pingInstance } from '../youtube/streams';
import { CloseIcon } from './Icons';

type Ping = { state: 'pending' } | { state: 'ok'; ms: number } | { state: 'fail'; msg: string };

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const [apiKey, setApiKey] = useState(s.apiKey);
  const [inv, setInv] = useState(s.invidious.join('\n'));
  const [piped, setPiped] = useState(s.piped.join('\n'));
  const [region, setRegion] = useState(s.region);
  const [pings, setPings] = useState<Record<string, Ping>>({});
  const hasEnvKey = !!import.meta.env.VITE_YOUTUBE_API_KEY;

  const save = () => {
    settings.update({
      apiKey: apiKey.trim(),
      invidious: parseInstanceList(inv),
      piped: parseInstanceList(piped),
      region: region.trim().toUpperCase() || 'US',
    });
  };

  const testAll = async () => {
    save();
    const list = [
      ...parseInstanceList(inv).map((b) => ['invidious', b] as const),
      ...parseInstanceList(piped).map((b) => ['piped', b] as const),
    ];
    setPings(Object.fromEntries(list.map(([, b]) => [b, { state: 'pending' } as Ping])));
    await Promise.all(
      list.map(async ([p, b]) => {
        try {
          const ms = await pingInstance(p, b);
          setPings((x) => ({ ...x, [b]: { state: 'ok', ms } }));
        } catch (e) {
          setPings((x) => ({ ...x, [b]: { state: 'fail', msg: (e as Error).message } }));
        }
      }),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="no-scrollbar h-full w-full max-w-2xl overflow-y-auto bg-surface p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-8 flex items-center justify-between">
          <h2 className="text-3xl font-bold">Settings</h2>
          <button
            aria-label="Close settings"
            onClick={() => {
              save();
              onClose();
            }}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 active:scale-95"
          >
            <CloseIcon size={30} />
          </button>
        </div>

        <Section title="Playback quality" hint="Auto starts at 720p and steps down on its own when the signal gets weak.">
          <div className="flex flex-wrap gap-3">
            {(['auto', 1080, 720, 480, 360] as QualityPref[]).map((q) => (
              <Chip key={q} active={s.quality === q} onClick={() => settings.update({ quality: q })}>
                {q === 'auto' ? 'Auto' : `${q}p`}
              </Chip>
            ))}
          </div>
        </Section>

        <Section
          title="Buffer ahead"
          hint="How much video to download in advance. More rides through dead zones and tunnels, but uses more data upfront."
        >
          <div className="flex flex-wrap gap-3">
            {[30, 60, 120, 240].map((sec) => (
              <Chip key={sec} active={s.bufferAhead === sec} onClick={() => settings.update({ bufferAhead: sec })}>
                {sec < 60 ? `${sec}s` : `${sec / 60} min`}
              </Chip>
            ))}
          </div>
        </Section>

        <Section
          title="YouTube API key"
          hint={hasEnvKey ? 'A key is built in. Anything entered here overrides it.' : 'Needed for search and trending. Pasted links work without it.'}
        >
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onBlur={save}
            placeholder={hasEnvKey ? 'Using built-in key' : 'AIza…'}
            className="h-14 w-full rounded-xl bg-surface-2 px-4 font-mono text-lg outline-none ring-1 ring-line focus:ring-2 focus:ring-accent"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="mt-3 flex items-center gap-3">
            <span className="text-muted">Trending region</span>
            <input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              onBlur={save}
              maxLength={2}
              className="h-12 w-20 rounded-xl bg-surface-2 text-center text-lg uppercase outline-none ring-1 ring-line"
            />
          </div>
        </Section>

        <Section
          title="Stream sources"
          hint="One URL per line, tried top to bottom. Put your own self-hosted instance first: public ones come and go."
        >
          <label className="mb-1 block text-muted">Invidious</label>
          <textarea
            value={inv}
            onChange={(e) => setInv(e.target.value)}
            onBlur={save}
            rows={3}
            className="mb-4 w-full rounded-xl bg-surface-2 p-3 font-mono text-base outline-none ring-1 ring-line focus:ring-2 focus:ring-accent"
            spellCheck={false}
          />
          <label className="mb-1 block text-muted">Piped API</label>
          <textarea
            value={piped}
            onChange={(e) => setPiped(e.target.value)}
            onBlur={save}
            rows={3}
            className="w-full rounded-xl bg-surface-2 p-3 font-mono text-base outline-none ring-1 ring-line focus:ring-2 focus:ring-accent"
            spellCheck={false}
          />
          <div className="mt-4 flex gap-3">
            <button onClick={() => void testAll()} className="h-14 rounded-full bg-accent px-6 text-lg font-semibold active:scale-95">
              Test sources
            </button>
            <button
              onClick={() => {
                setInv(envDefaults.invidious.join('\n'));
                setPiped(envDefaults.piped.join('\n'));
                settings.update({ invidious: envDefaults.invidious, piped: envDefaults.piped });
              }}
              className="h-14 rounded-full bg-surface-2 px-6 text-lg active:scale-95"
            >
              Restore defaults
            </button>
          </div>
          {Object.keys(pings).length > 0 && (
            <ul className="mt-4 space-y-2">
              {Object.entries(pings).map(([base, p]) => (
                <li key={base} className="flex items-center justify-between gap-4 rounded-xl bg-surface-2 px-4 py-3">
                  <span className="truncate font-mono text-sm">{base}</span>
                  <span
                    className={`shrink-0 text-sm font-semibold ${
                      p.state === 'ok' ? 'text-emerald-400' : p.state === 'fail' ? 'text-red-400' : 'text-muted'
                    }`}
                    title={p.state === 'fail' ? p.msg : undefined}
                  >
                    {p.state === 'ok' ? `OK · ${p.ms} ms` : p.state === 'fail' ? `Failed: ${p.msg.slice(0, 40)}` : 'Testing…'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Data">
          <div className="flex flex-wrap gap-3">
            <button onClick={() => history.clear()} className="h-14 rounded-full bg-surface-2 px-6 text-lg active:scale-95">
              Clear watch history
            </button>
            <button
              onClick={() => {
                settings.reset();
                setApiKey('');
                setInv(envDefaults.invidious.join('\n'));
                setPiped(envDefaults.piped.join('\n'));
                setRegion(envDefaults.region);
              }}
              className="h-14 rounded-full bg-surface-2 px-6 text-lg active:scale-95"
            >
              Reset all settings
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-9">
      <h3 className="text-xl font-semibold">{title}</h3>
      {hint && <p className="mb-4 mt-1 text-muted">{hint}</p>}
      {!hint && <div className="mb-4" />}
      {children}
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-14 min-w-24 rounded-full px-6 text-lg font-semibold active:scale-95 ${
        active ? 'bg-accent text-white' : 'bg-surface-2 text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}
