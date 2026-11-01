import { useSyncExternalStore } from 'react';
import { createStore, readJSON, writeJSON } from './store';

export interface HistoryEntry {
  id: string;
  title: string;
  channel?: string;
  thumbnail?: string;
  durationSec?: number;
  position: number;
  updatedAt: number;
}

const KEY = 'backseat.history.v1';
const MAX = 60;
const store = createStore<HistoryEntry[]>(readJSON<HistoryEntry[]>(KEY, []));

function persist() {
  writeJSON(KEY, store.get());
}

export const history = {
  get: store.get,
  subscribe: store.subscribe,
  touch(e: Omit<HistoryEntry, 'updatedAt' | 'position'> & { position?: number }) {
    store.set((list) => {
      const prev = list.find((x) => x.id === e.id);
      const next: HistoryEntry = {
        ...prev,
        ...e,
        position: e.position ?? prev?.position ?? 0,
        updatedAt: Date.now(),
      };
      return [next, ...list.filter((x) => x.id !== e.id)].slice(0, MAX);
    });
    persist();
  },
  savePosition(id: string, position: number, durationSec: number) {
    const list = store.get();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    // Near the end counts as finished: start over next time.
    const pos = durationSec && position > durationSec - 20 ? 0 : position;
    if (Math.abs(list[i].position - pos) < 1) return;
    const copy = list.slice();
    copy[i] = { ...copy[i], position: pos, durationSec: durationSec || copy[i].durationSec };
    store.set(copy);
    persist();
  },
  resumePosition(id: string): number {
    const e = store.get().find((x) => x.id === id);
    return e && e.position > 10 ? e.position : 0;
  },
  remove(id: string) {
    store.set((l) => l.filter((x) => x.id !== id));
    persist();
  },
  clear() {
    store.set([]);
    persist();
  },
};

export function useHistory() {
  return useSyncExternalStore(store.subscribe, store.get);
}
