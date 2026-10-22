import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Saved, SavedState, fromB64, loadStore, safeStorage, saveStore, toB64 } from './persist';
import { MemoryStorage } from './testing';

const KEYS = ['identity', 'settings', 'feed', 'store', 'files', 'chunks'] as const;
const P = 'resonance:v1:phone:';

/** The station test's scripted afternoon, as six strings, and the parts they hold. */
const fixture = JSON.parse(readFileSync(new URL('./station.fixture.json', import.meta.url), 'utf8')) as Record<string, string>;
const parts = () => Object.fromEntries(KEYS.map((k) => [k, JSON.parse(fixture[P + k])])) as unknown as Saved;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saved state', () => {
  it('writes each part under its key as JSON, and reads every one back', () => {
    const storage = new MemoryStorage();
    const saved = new SavedState(storage, 'phone');
    saved.save(parts());
    expect(storage.dump()).toEqual(fixture);
    expect(Object.keys(storage.dump())).toEqual(KEYS.map((k) => P + k));
    for (const k of KEYS) expect(saved.load(k)).toEqual(parts()[k]);
    expect(new SavedState(storage, 'beacon').load('identity')).toBeNull();
  });

  it('writes only the parts that differ from what storage holds, another tab included', () => {
    const storage = MemoryStorage.of(fixture);
    const setItem = vi.spyOn(storage, 'setItem');
    const saved = new SavedState(storage, 'phone');
    saved.save(parts());
    expect(setItem).not.toHaveBeenCalled();
    saved.save({ ...parts(), feed: parts().feed.slice(1) });
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([P + 'feed']);
    // Another tab of the same role saved its own settings: ours go back, as they always did.
    storage.setItem(P + 'settings', '{"nick":"Cal"}');
    setItem.mockClear();
    saved.save(parts());
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([P + 'settings', P + 'feed']);
    expect(storage.dump()).toEqual(fixture);
  });

  it('without storage, keeps nothing and finds nothing', () => {
    const saved = new SavedState(null, 'phone');
    expect(saved.available).toBe(false);
    expect(saved.load('identity')).toBeNull();
    expect(() => saved.save(parts())).not.toThrow();
  });

  it('reads a part it cannot parse, or a storage that refuses, as nothing saved', () => {
    expect(new SavedState(MemoryStorage.of({ [P + 'feed']: '[{"id":' }), 'phone').load('feed')).toBeNull();
    const blocked = MemoryStorage.of(fixture);
    vi.spyOn(blocked, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(new SavedState(blocked, 'phone').load('identity')).toBeNull();
  });

  it('keeps working when storage fills up, with the parts written before it filled', () => {
    const storage = new MemoryStorage();
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((k, v) => {
      if (k === P + 'store') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      setItem(k, v);
    });
    expect(() => new SavedState(storage, 'phone').save(parts())).not.toThrow();
    expect(Object.keys(storage.dump())).toEqual([P + 'identity', P + 'settings', P + 'feed']);
  });
});

describe('codecs', () => {
  it('base64 carries every byte value, and nothing at all', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromB64(toB64(all))).toEqual(all);
    expect(toB64(Uint8Array.of(1, 2, 3))).toBe('AQID');
    expect(toB64(new Uint8Array())).toBe('');
    expect(fromB64('')).toEqual(new Uint8Array());
  });

  it("the store keeps each packet's bytes and when it was first heard; after a reload nothing has been pushed", () => {
    const stored = saveStore([{ bytes: Uint8Array.of(1, 2, 3), firstHeard: 5000, lastPushed: 9000 }]);
    expect(stored).toEqual([{ b: 'AQID', t: 5000 }]);
    expect(loadStore(stored)).toEqual([{ bytes: Uint8Array.of(1, 2, 3), firstHeard: 5000, lastPushed: -Infinity }]);
  });
});

describe('safeStorage', () => {
  it("is the browser's storage when it keeps things, leaving no trace of the probe", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(safeStorage()).toBe(storage);
    expect(storage.length).toBe(0);
  });

  it('is null where storage refuses to keep anything, or is missing', () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    vi.stubGlobal('localStorage', storage);
    expect(safeStorage()).toBeNull();
    vi.stubGlobal('localStorage', undefined);
    expect(safeStorage()).toBeNull();
  });
});
