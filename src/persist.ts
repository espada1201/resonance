import type { SavedFiles } from './mesh/files';
import type { StoredPacket } from './mesh/node';
import type { FeedItem, Settings } from './station';

// What the station keeps between visits: six JSON strings under resonance:v1:<role>:, written
// and read through one schema. Storage holds strings, so bytes are saved as base64.

const KEY = 'resonance:v1:';

export interface Saved extends SavedFiles {
  identity: { id: number };
  /** Partial: a save from an older version may lack newer settings. */
  settings: Partial<Settings>;
  /** Newest first. */
  feed: FeedItem[];
  /** The mesh store: each packet's bytes, and when it was first heard. */
  store: Array<{ b: string; t: number }>;
}

/** The order the parts are written in: if storage fills up part-way, the first ones are kept. */
const PARTS: Array<keyof Saved> = ['identity', 'settings', 'feed', 'store', 'files', 'chunks'];

export const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const saveStore = (packets: Iterable<StoredPacket>): Saved['store'] => [...packets].map((p) => ({ b: toB64(p.bytes), t: p.firstHeard }));
export const loadStore = (saved: Saved['store']) => saved.map((x): StoredPacket => ({ bytes: fromB64(x.b), firstHeard: x.t, lastPushed: -Infinity }));

export class SavedState {
  private readonly prefix: string;

  constructor(
    private readonly storage: Storage | null,
    role: string,
  ) {
    this.prefix = `${KEY}${role}:`;
  }

  /** False when this browser keeps nothing (or the simulated air was asked for): saving is pointless. */
  get available() {
    return this.storage !== null;
  }

  load<K extends keyof Saved>(key: K): Saved[K] | null {
    try {
      const raw = this.storage?.getItem(this.prefix + key);
      return raw ? (JSON.parse(raw) as Saved[K]) : null;
    } catch {
      return null;
    }
  }

  /** Writes each part whose JSON differs from what storage holds, so a change that saves nothing writes nothing. */
  save(parts: Saved) {
    const s = this.storage;
    if (!s) return;
    try {
      for (const part of PARTS) {
        const json = JSON.stringify(parts[part]);
        if (s.getItem(this.prefix + part) !== json) s.setItem(this.prefix + part, json);
      }
    } catch {
      // Storage full or blocked: the app keeps working in memory.
    }
  }
}

/** The browser's localStorage, or null where it refuses to keep anything. */
export function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    s.setItem(KEY + 'probe', '1');
    s.removeItem(KEY + 'probe');
    return s;
  } catch {
    return null;
  }
}
