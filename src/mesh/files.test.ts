import { describe, expect, it } from 'vitest';
import { FileTransfer, type SavedFiles, chunkFile, fileKey } from './files';

const SELF = 0x0a0a0a;
const NEIGHBOUR = 0x123456;

// Five chunks: 0 (name and size) and four of data.
const chunks = chunkFile(77, { name: 'n.txt', mime: 'text/plain' }, new TextEncoder().encode('y'.repeat(600)));
const KEY = fileKey(NEIGHBOUR, 77);

/** A FileTransfer on a clock the test moves; random draws come from `draws`, then 0.5. */
function transfer(draws: number[] = []) {
  const clock = { t: 0, now: () => clock.t, random: () => draws.shift() ?? 0.5 };
  const files = new FileTransfer(SELF, clock);
  const asks: string[] = [];
  /** Runs the station's 200 ms chase for `ms`; each ask is noted as "+<seconds> [missing]". */
  const run = (ms: number, onAsk = () => {}) => {
    for (const end = clock.t + ms; clock.t < end; ) {
      clock.t += 200;
      files.chase((r) => {
        asks.push(`+${clock.t / 1000} [${r.missing}]`);
        onAsk();
      });
    }
  };
  return { files, clock, asks, run };
}

describe('file transfer', () => {
  it('a quiet file asks for its missing chunks three times, then leaves it to the button', () => {
    const { files, asks, run } = transfer();
    for (const i of [0, 1, 3]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 8);
    // Patience: max(20 s, 4 chunk airtimes) = 32 s, stretched by 1 + 0.75 × 0.5.
    run(600_000);
    expect(asks).toEqual(['+44 [2,4]', '+88 [2,4]', '+132 [2,4]']);
    expect(files.request(KEY)).toEqual({ kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 77, missing: [2, 4] });
  });

  it('a new chunk renews the asks and the patience', () => {
    const { files, asks, run } = transfer();
    for (const i of [0, 1, 3]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 8);
    run(50_000);
    files.heard(NEIGHBOUR, chunks[2], 902, 2);
    run(600_000);
    // 20 s × 1.375 after each.
    expect(asks).toEqual(['+44 [2,4]', '+77.6 [4]', '+105.2 [4]', '+132.8 [4]']);
  });

  it('a file that fills up stops asking', () => {
    const { files, asks, run } = transfer();
    for (const i of [0, 1, 3]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 8);
    run(50_000);
    for (const i of [2, 4]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 8);
    run(600_000);
    expect(asks).toEqual(['+44 [2,4]']);
    expect(files.data(KEY)).toEqual(new TextEncoder().encode('y'.repeat(600)));
  });

  it("a neighbour's ask for the same file puts ours off", () => {
    const { files, asks, run } = transfer();
    for (const i of [0, 1, 3]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 8);
    run(30_000);
    files.asked({ kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 77, missing: [2, 4] });
    run(600_000);
    expect(asks).toEqual(['+74 [2,4]', '+118 [2,4]', '+162 [2,4]']);
  });

  it('each ask is re-armed before it goes out, so a sender that draws from the clock draws next', () => {
    // The first re-arm takes 0 (wait 32 s) and the send takes 1; the other way round it would wait 56 s.
    const draws: number[] = [];
    const { files, clock, asks, run } = transfer(draws);
    for (const i of [0, 1, 3]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 8);
    draws.push(0, 1);
    run(130_000, () => void clock.random());
    expect(asks).toEqual(['+44 [2,4]', '+76 [2,4]', '+120 [2,4]']);
  });

  it('answers an ask with the chunks it holds, from the first eight asked for', () => {
    const { files } = transfer();
    const eleven = chunkFile(78, { name: 'm.txt', mime: 'text/plain' }, new TextEncoder().encode('z'.repeat(1600)));
    eleven.forEach((c, i) => i !== 3 && files.heard(NEIGHBOUR, c, 700 + i, 2));
    expect(files.asked({ kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 78, missing: [...eleven.keys()] })).toEqual([700, 701, 702, 704, 705, 706, 707]);
    expect(files.asked({ kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 99, missing: [1] })).toEqual([]);
  });

  it('holds its own files whole, answers for each chunk once it has gone out, and never chases them', () => {
    const { files, asks, run } = transfer();
    const data = new TextEncoder().encode('x'.repeat(500));
    const { key, chunks: own } = files.create(5, { name: 'mine.txt', mime: 'text/plain' }, data);
    expect(key).toBe(fileKey(SELF, 5));
    expect(files.data(key)).toEqual(data);
    expect(files.asked({ kind: 'filereq', fileSrc: SELF, fileId: 5, missing: [1, 2] })).toEqual([]);
    own.forEach((c, i) => files.sent(c, 300 + i));
    expect(files.asked({ kind: 'filereq', fileSrc: SELF, fileId: 5, missing: [1, 2] })).toEqual([301, 302]);
    // Even one of its own chunks coming back incomplete is not chased.
    files.heard(SELF, { ...own[1], fileId: 6 }, 400, 8);
    run(600_000);
    expect(asks).toEqual([]);
  });

  it('keeps every chunk, the first included, through a save and a reload', () => {
    const { files } = transfer();
    for (const i of [0, 1, 3]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 2);
    const own = files.create(5, { name: 'mine.txt', mime: 'text/plain' }, new TextEncoder().encode('x'.repeat(500)));
    own.chunks.forEach((c, i) => files.sent(c, 300 + i));
    const saved = JSON.parse(JSON.stringify(files.snapshot())) as SavedFiles;

    const { files: reloaded } = transfer();
    reloaded.restore(saved);
    expect(reloaded.snapshot()).toEqual(saved);
    expect(reloaded.request(KEY)?.missing).toEqual([2, 4]);
    expect(reloaded.data(own.key)).toEqual(new TextEncoder().encode('x'.repeat(500)));
    expect(reloaded.asked({ kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 77, missing: [0, 1, 2] })).toEqual([900, 901]);
  });

  it('restores an empty chunk as held: only null means missing', () => {
    const { files } = transfer();
    const meta = { name: 'empty.txt', mime: 'text/plain', size: 0 };
    files.heard(NEIGHBOUR, { kind: 'file', fileId: 79, index: 0, total: 2, meta, data: new Uint8Array() }, 960, 2);
    files.heard(NEIGHBOUR, { kind: 'file', fileId: 79, index: 1, total: 2, data: new Uint8Array() }, 961, 2);
    const saved = JSON.parse(JSON.stringify(files.snapshot())) as SavedFiles;
    expect(saved.files[0].chunks).toEqual(['', '']);

    const { files: reloaded } = transfer();
    reloaded.restore(saved);
    expect(reloaded.request(fileKey(NEIGHBOUR, 79))?.missing).toEqual([]);
    expect(reloaded.data(fileKey(NEIGHBOUR, 79))).toEqual(new Uint8Array());
  });

  it('mends a save that lost chunk 0, which only a file with a name and size had', () => {
    const { files } = transfer();
    for (const i of [0, 1, 2, 3, 4]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 2);
    const nameless = chunkFile(78, { name: 'm.txt', mime: 'text/plain' }, new TextEncoder().encode('z'.repeat(300)));
    files.heard(NEIGHBOUR, nameless[1], 951, 2);
    const saved = files.snapshot();
    for (const f of saved.files) f.chunks[0] = null;

    const { files: reloaded } = transfer();
    reloaded.restore(saved);
    expect(reloaded.data(KEY)).toEqual(new TextEncoder().encode('y'.repeat(600)));
    expect(reloaded.request(fileKey(NEIGHBOUR, 78))?.missing).toEqual([0, 2]);
  });

  it('holds the 100 files heard last, forgetting the oldest first', () => {
    // A beacon hears files for days. Storage holds about 5 MB, and every save encodes every file.
    const { files } = transfer();
    for (let id = 0; id <= 100; id++) files.heard(NEIGHBOUR, chunkFile(id, { name: 'p.jpg', mime: 'image/jpeg' }, new Uint8Array(400))[1], 1000 + id, 8);
    expect(files.get(fileKey(NEIGHBOUR, 0))).toBeUndefined();
    expect(files.asked({ kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 0, missing: [1] })).toEqual([]);
    expect(files.asked({ kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 100, missing: [1] })).toEqual([1100]);
    expect(files.snapshot().files).toHaveLength(100);
    expect(files.snapshot().chunks).toHaveLength(100);
  });

  it('forgets everything on clear; a wait still pending lapses without asking', () => {
    const { files, asks, run } = transfer();
    for (const i of [0, 1, 3]) files.heard(NEIGHBOUR, chunks[i], 900 + i, 8);
    files.clear();
    run(600_000);
    expect(asks).toEqual([]);
    expect(files.get(KEY)).toBeUndefined();
    expect(files.request(KEY)).toBeNull();
    expect(files.asked({ kind: 'filereq', fileSrc: NEIGHBOUR, fileId: 77, missing: [0, 1] })).toEqual([]);
    expect(files.snapshot()).toEqual({ files: [], chunks: [] });
  });
});
