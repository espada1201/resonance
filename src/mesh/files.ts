import { fromB64, toB64 } from '../persist';
import type { MeshClock } from './node';
import type { Body, FileMeta } from './payloads';

// Tiny files ride as numbered chunks. Chunk 0 carries only the name/type/size; the rest carry
// data. Anyone holding a chunk can answer a request for it (the holder nearest the asker goes
// first), so files heal across the mesh.

export const MAX_FILE_BYTES = 4096;
export const CHUNK_BYTES = 160;
/** File requests go one relay deep: far enough to reach a holder, near enough to keep the air quiet. */
export const FILE_REQUEST_TTL = 2;
/**
 * Someone else's file that goes quiet asks for its missing pieces. Each chunk shares the air with
 * neighbours' relays of the one before, so quiet means a few chunk airtimes, never under 20 s.
 * The wait is stretched by up to 75% at random, so a crowd missing the same chunk does not ask at once.
 */
const PATIENCE_MS = 20_000;
const PATIENCE_AIRTIMES = 4;
/** Automatic asks per file that bring nothing new; after that the feed's "Ask for missing" button is left. */
const AUTO_ASKS = 3;
/** Chunks of one request a holder answers: the first this many asked for. */
const ANSWERS_PER_ASK = 8;

export type FileBody = Extract<Body, { kind: 'file' }>;
export type FileRequest = Extract<Body, { kind: 'filereq' }>;

export function chunkFile(fileId: number, meta: Omit<FileMeta, 'size'>, data: Uint8Array): FileBody[] {
  if (data.length > MAX_FILE_BYTES) throw new Error(`files are limited to ${MAX_FILE_BYTES} bytes`);
  const parts = Math.ceil(data.length / CHUNK_BYTES);
  const total = parts + 1;
  const chunks: FileBody[] = [{ kind: 'file', fileId, index: 0, total, meta: { ...meta, size: data.length }, data: new Uint8Array() }];
  for (let i = 0; i < parts; i++) {
    chunks.push({ kind: 'file', fileId, index: i + 1, total, data: data.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  }
  return chunks;
}

export interface FileState {
  key: string;
  src: number;
  fileId: number;
  total: number;
  meta?: FileMeta;
  chunks: Array<Uint8Array | undefined>;
}

export const fileKey = (src: number, fileId: number) => `${src}:${fileId}`;

export const received = (f: FileState) => f.chunks.filter(Boolean).length;
export const missing = (f: FileState) => [...Array(f.total).keys()].filter((i) => !f.chunks[i]);

/** Joins the chunks once everything has arrived and the size matches. */
export function assemble(f: FileState): Uint8Array | null {
  if (!f.meta || missing(f).length) return null;
  const out = new Uint8Array(f.meta.size);
  let off = 0;
  for (let i = 1; i < f.total; i++) {
    const c = f.chunks[i]!;
    if (off + c.length > out.length) return null;
    out.set(c, off);
    off += c.length;
  }
  return off === out.length ? out : null;
}

/** Adds a chunk to the file table; returns the file's state. */
export function addChunk(files: Map<string, FileState>, src: number, c: FileBody): FileState {
  const key = fileKey(src, c.fileId);
  let f = files.get(key);
  if (!f || f.total !== c.total) {
    f = { key, src, fileId: c.fileId, total: c.total, chunks: new Array(c.total) };
    files.set(key, f);
  }
  if (c.index < f.total) f.chunks[c.index] = c.data;
  if (c.index === 0 && c.meta) f.meta = c.meta;
  return f;
}

/** A file as saved: its chunks in base64, null where missing. */
export type SavedFile = Omit<FileState, 'chunks'> & { chunks: Array<string | null> };
export interface SavedFiles {
  files: SavedFile[];
  /** The message id of every chunk held, by file and index. */
  chunks: Array<[string, Array<[number, number]>]>;
}

const requestFor = (f: FileState): FileRequest => ({ kind: 'filereq', fileSrc: f.src, fileId: f.fileId, missing: missing(f) });

/**
 * Every file this station holds, its own and its neighbours', and the policy that heals them: a
 * file that goes quiet asks for its missing chunks, and a chunk held is handed to whoever asks.
 * Sending stays with the caller.
 */
export class FileTransfer {
  private readonly files = new Map<string, FileState>();
  /** The message id of each chunk held: an answer re-sends that packet from the mesh store. */
  private readonly ids = new Map<string, Map<number, number>>();
  private readonly waits = new Map<string, { due: number; asks: number; patienceMs: number }>();

  constructor(
    private readonly self: number,
    private readonly clock: MeshClock,
  ) {}

  get(key: string) {
    return this.files.get(key);
  }

  /** The file's bytes, once every chunk is in. */
  data(key: string) {
    const f = this.files.get(key);
    return f ? assemble(f) : null;
  }

  /** Splits one of our own files into chunks and holds them. */
  create(fileId: number, meta: Omit<FileMeta, 'size'>, data: Uint8Array) {
    const chunks = chunkFile(fileId, meta, data);
    for (const c of chunks) addChunk(this.files, this.self, c);
    return { key: fileKey(this.self, fileId), chunks };
  }

  /** One of our own chunks went out as message `msgId`. */
  sent(c: FileBody, msgId: number) {
    this.track(this.self, c, msgId);
  }

  /** A chunk of someone else's file arrived, after `airtimeSec` on air. */
  heard(src: number, c: FileBody, msgId: number, airtimeSec: number): FileState {
    this.track(src, c, msgId);
    const f = addChunk(this.files, src, c);
    this.expectMore(f.key, airtimeSec);
    return f;
  }

  /**
   * Someone asked for chunks of a file. Returns the message ids of those we hold, for the mesh to
   * answer with.
   */
  asked(req: FileRequest): number[] {
    const key = fileKey(req.fileSrc, req.fileId);
    // Someone already asked for a file we are missing too: their answer may fill our gaps.
    if (this.waits.has(key)) this.expectMore(key);
    const ids = this.ids.get(key);
    if (!ids) return [];
    return req.missing
      .slice(0, ANSWERS_PER_ASK)
      .map((i) => ids.get(i))
      .filter((id) => id !== undefined);
  }

  /** A request for the chunks of a file we are still missing (the feed's "Ask for missing"). */
  request(key: string): FileRequest | null {
    const f = this.files.get(key);
    return f ? requestFor(f) : null;
  }

  /** Asks for the missing pieces of files that went quiet: a lost chunk is otherwise lost for good. */
  chase(ask: (req: FileRequest) => void) {
    const now = this.clock.now();
    for (const [key, w] of this.waits) {
      if (w.due > now) continue;
      const f = this.files.get(key);
      if (!f || !missing(f).length || w.asks >= AUTO_ASKS) {
        this.waits.delete(key);
        continue;
      }
      w.asks++;
      this.expectMore(key);
      ask(requestFor(f));
    }
  }

  snapshot(): SavedFiles {
    return {
      files: [...this.files.values()].map((f) => ({ ...f, chunks: f.chunks.map((c) => (c ? toB64(c) : null)) })),
      chunks: [...this.ids].map(([k, m]): [string, Array<[number, number]>] => [k, [...m]]),
    };
  }

  restore(saved: SavedFiles) {
    for (const f of saved.files) {
      // Chunk 0 holds no data, so it is saved as "": that is a chunk, not a missing one.
      const chunks = f.chunks.map((c) => (c === null ? undefined : fromB64(c)));
      // Earlier versions lost chunk 0 on every reload. Only chunk 0 brings the name and size, so a
      // file that has them had it.
      if (f.meta) chunks[0] ??= new Uint8Array();
      this.files.set(f.key, { ...f, chunks });
    }
    for (const [k, m] of saved.chunks) this.ids.set(k, new Map(m));
  }

  /** Forgets every file. A wait still pending lapses at its next chase, finding its file gone. */
  clear() {
    this.files.clear();
    this.ids.clear();
  }

  private track(src: number, c: FileBody, msgId: number) {
    const k = fileKey(src, c.fileId);
    const ids = this.ids.get(k) ?? new Map<number, number>();
    ids.set(c.index, msgId);
    this.ids.set(k, ids);
  }

  /**
   * Heard from someone else's unfinished file: give it time before asking for the rest. A new chunk
   * (with its airtime) means the file is moving, which also renews the automatic asks.
   */
  private expectMore(key: string, chunkAirtimeSec?: number) {
    const f = this.files.get(key);
    if (!f || f.src === this.self || !missing(f).length) {
      this.waits.delete(key);
      return;
    }
    const w = this.waits.get(key) ?? { due: 0, asks: 0, patienceMs: PATIENCE_MS };
    if (chunkAirtimeSec !== undefined) {
      w.asks = 0;
      w.patienceMs = Math.max(PATIENCE_MS, PATIENCE_AIRTIMES * chunkAirtimeSec * 1000);
    }
    w.due = this.clock.now() + w.patienceMs * (1 + 0.75 * this.clock.random());
    this.waits.set(key, w);
  }
}
