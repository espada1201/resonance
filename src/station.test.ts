import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AirTransport } from './audio/transport';
import { chunkFile, fileKey, missing } from './mesh/files';
import { BROADCAST, PacketType, encodePacket } from './mesh/packet';
import { type Body, encodeBody } from './mesh/payloads';
import type { DecodedFrame } from './modem/receiver';
import { Station } from './station';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const air: AirTransport = { kind: 'simulated', start: async () => 48000, play: async () => undefined, setVolume() {} };

const NEIGHBOUR = 0x123456;

/** A frame the demodulator decoded off the air, carrying `body` from `src`. */
function heard(src: number, msgId: number, body: Body, airtimeSec = 2): DecodedFrame {
  const type = { text: PacketType.Text, file: PacketType.FileChunk, filereq: PacketType.FileRequest }[body.kind as 'text' | 'file' | 'filereq'];
  const payload = encodePacket({ type, encrypted: false, ackRequested: false, msgId, src, dst: BROADCAST, ttl: 5, hops: 0, attempt: 0, channel: 0, body: encodeBody(body) });
  return { payload, profile: 'audible', startSample: 0, airtimeSec, clockRatio: 1, toneSnrDb: 20, corrected: 0 };
}

beforeEach(() => {
  // The constructor listens for the page coming back into view.
  vi.stubGlobal('document', { addEventListener() {}, visibilityState: 'visible' });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saved files', () => {
  const theirs = new TextEncoder().encode('Open shelters tonight: St Thomas church hall, 40 beds. '.repeat(6));
  const mine = new TextEncoder().encode('My own note, sent from this phone. '.repeat(8));

  /** A station that heard a neighbour's file whole and sent one of its own, then saved. */
  async function session(storage: Storage) {
    const s = new Station(air, 'phone', storage);
    chunkFile(77, { name: 'shelters.txt', mime: 'text/plain' }, theirs).forEach((c, i) => s.onFrame(heard(NEIGHBOUR, 500 + i, c)));
    const own = await s.sendFile('note.txt', 'text/plain', mine);
    s.save();
    return { theirKey: fileKey(NEIGHBOUR, 77), ownKey: own };
  }

  it('a received file and an own file survive a reload whole', async () => {
    const storage = new MemoryStorage();
    const { theirKey, ownKey } = await session(storage);

    const reloaded = new Station(air, 'phone', storage);
    expect(missing(reloaded.files.get(theirKey)!)).toEqual([]);
    expect(missing(reloaded.files.get(ownKey)!)).toEqual([]);
    expect(reloaded.fileData(theirKey)).toEqual(theirs);
    expect(reloaded.fileData(ownKey)).toEqual(mine);
  });

  it('files an earlier version damaged on reload come back whole', async () => {
    const storage = new MemoryStorage();
    const { theirKey, ownKey } = await session(storage);
    // What that version saved after a reload: chunk 0 (name and size, no data) as missing.
    const key = 'resonance:v1:phone:files';
    const damaged = JSON.parse(storage.getItem(key)!) as Array<{ chunks: Array<string | null> }>;
    for (const f of damaged) f.chunks[0] = null;
    storage.setItem(key, JSON.stringify(damaged));

    const reloaded = new Station(air, 'phone', storage);
    expect(reloaded.fileData(theirKey)).toEqual(theirs);
    expect(reloaded.fileData(ownKey)).toEqual(mine);
  });

  it('a file whose first chunk never arrived is still missing it after a reload', () => {
    const storage = new MemoryStorage();
    const s = new Station(air, 'phone', storage);
    chunkFile(78, { name: 'map.txt', mime: 'text/plain' }, theirs).forEach((c, i) => i > 0 && s.onFrame(heard(NEIGHBOUR, 600 + i, c)));
    s.save();

    const reloaded = new Station(air, 'phone', storage);
    expect(missing(reloaded.files.get(fileKey(NEIGHBOUR, 78))!)).toEqual([0]);
    expect(reloaded.fileData(fileKey(NEIGHBOUR, 78))).toBeNull();
  });
});
