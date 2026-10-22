import type { FeedItem } from './journal';
import type { SavedFiles } from './mesh/files';
import type { StoredPacket } from './mesh/node';
import type { SafetySnapshot } from './roster';
import type { Settings } from './station';

// What the station keeps between visits: seven JSON strings under resonance:v1:<role>:, written
// and read through one schema. Storage holds strings, so bytes are saved as base64.

const KEY = 'resonance:v1:';

export interface Saved extends SavedFiles {
  identity: { id: number };
  /** Partial: a save from an older version may lack newer settings. */
  settings: Partial<Settings>;
  /** Check-ins, replies and notices: three days, 600 of each. */
  safety: SafetySnapshot;
  /** Newest first. */
  feed: FeedItem[];
  /** The mesh store: each packet's bytes, when it was first heard, and `q` if it is ours and has not been on air. */
  store: Array<{ b: string; t: number; q?: 1 }>;
}

/**
 * The order the parts are written in: if storage fills up part-way, the first ones are kept, so who
 * needs help outlives the chat. Listing them as keys makes the build fail when a part is left out.
 */
const PARTS = Object.keys({ identity: 1, settings: 1, safety: 1, feed: 1, store: 1, files: 1, chunks: 1 } satisfies Record<keyof Saved, 1>) as Array<keyof Saved>;

export const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const saveStore = (packets: Iterable<StoredPacket>): Saved['store'] => [...packets].map((p) => ({ b: toB64(p.bytes), t: p.firstHeard, ...(p.queued && { q: 1 as const }) }));
export const loadStore = (saved: Saved['store']) => saved.map((x): StoredPacket => ({ bytes: fromB64(x.b), firstHeard: x.t, lastPushed: -Infinity, queued: x.q === 1 }));

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
