import type { FromWorker, ToWorker } from './audio/protocol';

// Test doubles shared by the unit tests. Nothing in the app imports this file.

/** localStorage in a Map. */
export class MemoryStorage implements Storage {
  private m = new Map<string, string>();

  static of(items: Record<string, string>) {
    const s = new MemoryStorage();
    for (const [k, v] of Object.entries(items)) s.setItem(k, v);
    return s;
  }

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
  /** Every key and its string, in the order first written. */
  dump() {
    return Object.fromEntries(this.m);
  }
}

/** A decoder worker that records what it is sent, and speaks or fails when the test says. */
export class StubWorker {
  readonly posted: Array<{ m: ToWorker; transfer: Transferable[] }> = [];
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;

  /** `onPost` sees each message as it is posted. */
  constructor(private readonly onPost: (m: ToWorker) => void = () => undefined) {}

  postMessage(m: ToWorker, transfer: Transferable[] = []) {
    this.posted.push({ m, transfer });
    this.onPost(m);
  }
  terminate() {
    this.terminated = true;
  }
  say(m: FromWorker) {
    this.onmessage!({ data: m } as MessageEvent<FromWorker>);
  }
  fail() {
    this.onerror!({ preventDefault() {} } as ErrorEvent);
  }
}
