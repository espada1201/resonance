import { nextPow2 } from './dsp';

/** Append-only sample store addressed by absolute index; old samples are discarded on trim. */
export class SampleStore {
  data = new Float32Array(1 << 16);
  base = 0;
  length = 0;
  get end() {
    return this.base + this.length;
  }
  push(chunk: Float32Array) {
    if (this.length + chunk.length > this.data.length) {
      const next = new Float32Array(nextPow2(this.length + chunk.length) * 2);
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    this.data.set(chunk, this.length);
    this.length += chunk.length;
  }
  trimBefore(abs: number) {
    const drop = Math.min(this.length, Math.floor(abs - this.base));
    if (drop <= 0) return;
    this.data.copyWithin(0, drop, this.length);
    this.length -= drop;
    this.base += drop;
  }
  /**
   * `n` samples from `abs`: a view while they are all stored (valid until the next push or trim),
   * otherwise a copy with zeros where nothing is stored.
   */
  view(abs: number, n: number): Float32Array {
    const from = abs - this.base;
    if (from >= 0 && from + n <= this.length) return this.data.subarray(from, from + n);
    const out = new Float32Array(n);
    for (let i = Math.max(0, -from); i < n && from + i < this.length; i++) out[i] = this.data[from + i];
    return out;
  }
  /** Cubic interpolation at a fractional absolute position (0 outside what is stored). */
  at(pos: number): number {
    const x = pos - this.base;
    const i = Math.floor(x);
    const f = x - i;
    const y = (j: number) => (j >= 0 && j < this.length ? this.data[j] : 0);
    const y0 = y(i - 1), y1 = y(i), y2 = y(i + 1), y3 = y(i + 2);
    return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
  }
}
