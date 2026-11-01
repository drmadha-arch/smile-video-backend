import { useSyncExternalStore } from 'react';
import { createStore, readJSON, writeJSON } from './store';

export type QualityPref = 'auto' | 1080 | 720 | 480 | 360;

export interface Settings {
  /** Overrides VITE_YOUTUBE_API_KEY when non-empty. */
  apiKey: string;
  region: string;
  invidious: string[];
  piped: string[];
  quality: QualityPref;
  /** Seconds of media to download ahead. More = better through dead zones. */
  bufferAhead: number;
  volume: number;
  showStats: boolean;
}

const env = import.meta.env;
const list = (v: string | undefined) =>
  (v ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

export const envDefaults: Settings = {
  apiKey: '',
  region: env.VITE_YOUTUBE_REGION || 'US',
  invidious: list(env.VITE_INVIDIOUS_INSTANCES ?? 'https://inv.nadeko.net,https://invidious.nerdvpn.de'),
  piped: list(env.VITE_PIPED_INSTANCES ?? 'https://pipedapi.kavin.rocks,https://api.piped.private.coffee'),
  quality: 'auto',
  bufferAhead: 60,
  volume: 1,
  showStats: false,
};

const KEY = 'backseat.settings.v1';
const store = createStore<Settings>({ ...envDefaults, ...readJSON<Partial<Settings>>(KEY, {}) });

export const settings = {
  get: store.get,
  subscribe: store.subscribe,
  update(patch: Partial<Settings>) {
    store.set((s) => ({ ...s, ...patch }));
    writeJSON(KEY, store.get());
  },
  reset() {
    store.set({ ...envDefaults });
    writeJSON(KEY, {});
  },
  apiKey(): string {
    return store.get().apiKey.trim() || (env.VITE_YOUTUBE_API_KEY ?? '').trim();
  },
};

export const parseInstanceList = list;

export function useSettings(): Settings {
  return useSyncExternalStore(store.subscribe, store.get);
}
