import { describe, expect, it } from 'vitest';
import { rsDecode, rsEncode } from './rs';

function rng(seed: number) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('Reed-Solomon GF(256)', () => {
  it('matches a known-good codeword (Wikiversity reference vector)', () => {
    // "hello world" with 10 parity symbols, from the Wikiversity RS tutorial.
    const msg = new TextEncoder().encode('hello world');
    const cw = rsEncode(msg, 10);
    expect(Array.from(cw.slice(11))).toEqual([0xed, 0x25, 0x54, 0xc4, 0xfd, 0xfd, 0x89, 0xf3, 0xa8, 0xaa]);
  });

  it('corrects up to nsym/2 random errors', () => {
    const r = rng(7);
    for (let trial = 0; trial < 300; trial++) {
      const k = 1 + Math.floor(r() * 60);
      const nsym = 2 + 2 * Math.floor(r() * 12);
      const data = Uint8Array.from({ length: k }, () => Math.floor(r() * 256));
      const cw = rsEncode(data, nsym);
      const bad = cw.slice();
      const nerr = Math.floor(r() * (nsym / 2 + 1));
      const pos = new Set<number>();
      while (pos.size < nerr) pos.add(Math.floor(r() * cw.length));
      for (const p of pos) bad[p] ^= 1 + Math.floor(r() * 255);
      const out = rsDecode(bad, nsym);
      expect(out, `trial ${trial}`).not.toBeNull();
      expect(Array.from(out!.data)).toEqual(Array.from(data));
      expect(out!.corrected).toBe(nerr);
    }
  });

  it('corrects errors and erasures together (2e + f <= nsym)', () => {
    const r = rng(99);
    for (let trial = 0; trial < 300; trial++) {
      const k = 4 + Math.floor(r() * 40);
      const nsym = 16;
      const data = Uint8Array.from({ length: k }, () => Math.floor(r() * 256));
      const cw = rsEncode(data, nsym);
      const f = Math.floor(r() * 9);
      const e = Math.floor((nsym - f) / 2);
      const all = [...Array(cw.length).keys()].sort(() => r() - 0.5);
      const erasures = all.slice(0, f);
      const errors = all.slice(f, f + e);
      const bad = cw.slice();
      for (const p of [...erasures, ...errors]) bad[p] ^= 1 + Math.floor(r() * 255);
      const out = rsDecode(bad, nsym, erasures);
      expect(out, `trial ${trial}`).not.toBeNull();
      expect(Array.from(out!.data)).toEqual(Array.from(data));
    }
  });

  it('reports failure rather than miscorrecting when far beyond capacity', () => {
    const r = rng(3);
    let wrong = 0;
    for (let trial = 0; trial < 200; trial++) {
      const data = Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256));
      const bad = rsEncode(data, 16);
      for (let i = 0; i < 20; i++) bad[i] ^= 0x5a;
      const out = rsDecode(bad, 16);
      if (out && Array.from(out.data).join() !== Array.from(data).join()) wrong++;
    }
    // Miscorrection is possible in principle; the outer CRC32 catches it. It must be rare.
    expect(wrong).toBeLessThan(5);
  });
});
