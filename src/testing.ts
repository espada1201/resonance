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
