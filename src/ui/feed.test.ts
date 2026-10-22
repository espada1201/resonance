import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../journal';
import { BROADCAST } from '../mesh/packet';
import type { Station } from '../station';
import { preview, saveSound, vcard } from './feed';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le = (n: number, bytes: number) => [...Array(bytes).keys()].map((i) => (n >>> (8 * i)) & 255);
const be = (n: number, bytes: number) => le(n, bytes).reverse();

// Just enough of each format's header to say how big the picture is.
const png = (w: number, h: number) => Uint8Array.from([...ascii('\x89PNG\r\n\x1a\n'), ...be(13, 4), ...ascii('IHDR'), ...be(w, 4), ...be(h, 4), 8, 6, 0, 0, 0]);
const jpeg = (w: number, h: number) =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...be(16, 2), ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, ...be(11, 2), 8, ...be(h, 2), ...be(w, 2), 1, 1, 0x11, 0]);
/** A two-colour palette, a frame delay, then the first frame, which may reach past the screen. */
const gif = (w: number, h: number, frame = [0, 0, w, h]) =>
  Uint8Array.from([...ascii('GIF89a'), ...le(w, 2), ...le(h, 2), 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, ...frame.flatMap((n) => le(n, 2)), 0]);
const webp = (chunk: string, data: number[]) => Uint8Array.from([...ascii('RIFF'), ...le(12 + data.length, 4), ...ascii('WEBP'), ...ascii(chunk), ...le(data.length, 4), ...data]);
const lossy = (w: number, h: number) => webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le(w, 2), ...le(h, 2)]);
const lossless = (w: number, h: number) => webp('VP8L', [0x2f, ...le((w - 1) | ((h - 1) << 14), 4)]);
const extended = (w: number, h: number) => webp('VP8X', [0, 0, 0, 0, ...le(w - 1, 3), ...le(h - 1, 3)]);

describe('received pictures', () => {
  it('draws a small picture of every kind it previews', () => {
    expect(preview('image/png', png(1, 1))).toBe('picture');
    expect(preview('image/jpeg', jpeg(240, 180))).toBe('picture');
    expect(preview('image/gif', gif(16, 16))).toBe('picture');
    for (const picture of [lossy, lossless, extended]) expect(preview('image/webp', picture(240, 180))).toBe('picture');
  });

  it('says a picture is too large to draw when its header asks for more pixels than a phone should decode, however small the file', () => {
    expect(preview('image/webp', lossless(16383, 16383))).toBe('too large');
    expect(preview('image/webp', lossy(16383, 16383))).toBe('too large');
    expect(preview('image/webp', extended(65536, 65536))).toBe('too large');
    expect(preview('image/png', png(100_000, 1))).toBe('too large');
    expect(preview('image/jpeg', jpeg(65535, 65535))).toBe('too large');
    expect(preview('image/gif', gif(1, 1, [0, 0, 65535, 65535]))).toBe('too large');
  });

  it('draws nothing whose size it cannot read from the header, whatever type the file claims', () => {
    expect(preview('image/png', Uint8Array.from([...ascii('BM'), ...le(1 << 20, 4)]))).toBeNull();
    expect(preview('image/gif', gif(1, 1).subarray(0, 24))).toBeNull();
    expect(preview('text/plain', png(1, 1))).toBeNull();
  });
});

describe('saved contacts', () => {
  it('keeps a line break of any kind inside its field, so a name or note cannot add a phone number or a second card', async () => {
    const card = await vcard('Ana\rTEL:+19005550199', '+1 555 0100', 'nurse\r\nEND:VCARD\rBEGIN:VCARD').text();
    expect(card).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Ana\\nTEL:+19005550199;;;\r\nFN:Ana\\nTEL:+19005550199\r\nTEL:+1 555 0100\r\nNOTE:nurse\\nEND:VCARD\\nBEGIN:VCARD\r\nEND:VCARD\r\n',
    );
  });
});

describe('sound files', () => {
  it('says so when the device no longer keeps the packet, rather than saving nothing in silence', () => {
    const forgot = { exportWav: () => null } as unknown as Station;
    const item: FeedItem = { id: '1:2', src: 1, msgId: 2, at: 0, hops: 0, encrypted: false, dst: BROADCAST, mine: false, locked: false };
    expect(() => saveSound(forgot, item)).toThrow('This device no longer keeps this packet, so it cannot be saved as sound.');
  });
});
