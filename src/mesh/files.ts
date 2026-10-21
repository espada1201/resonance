import type { Body, FileMeta } from './payloads';

// Tiny files ride as numbered chunks. Chunk 0 carries only the name/type/size; the rest carry
// data. Any node that holds a chunk can answer a request for it, so files heal across the mesh.

export const MAX_FILE_BYTES = 4096;
export const CHUNK_BYTES = 160;

export type FileBody = Extract<Body, { kind: 'file' }>;

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
  firstSeen: number;
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
export function addChunk(files: Map<string, FileState>, src: number, c: FileBody, now: number): FileState {
  const key = fileKey(src, c.fileId);
  let f = files.get(key);
  if (!f || f.total !== c.total) {
    f = { key, src, fileId: c.fileId, total: c.total, chunks: new Array(c.total), firstSeen: now };
    files.set(key, f);
  }
  if (c.index < f.total) f.chunks[c.index] = c.data;
  if (c.index === 0 && c.meta) f.meta = c.meta;
  return f;
}
