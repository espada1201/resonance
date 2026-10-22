import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicTransport } from './transport';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * A secure page in a browser whose audio and microphone log what is asked of them, in order.
 * `fail` makes the microphone prompt or the worklet's loading throw.
 */
function browser(opts: { fail?: 'microphone' | 'worklet'; otherPageListens?: boolean } = {}) {
  const log: string[] = [];
  // The browser's lock manager: one holder per name, kept until its callback's promise settles.
  let held = opts.otherPageListens ?? false;
  const locks = {
    request: async (name: string, _opts: unknown, take: (lock: { name: string } | null) => unknown) => {
      const lock = held ? null : { name };
      if (lock) held = true;
      return take(lock);
    },
  };
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  /** A locked phone gives audio back to nobody: resume() never settles. */
  const phone = { locked: false };
  const sounds: Array<{ onended: (() => void) | null }> = [];
  let ctx: FakeContext | null = null;
  class FakeContext extends EventTarget {
    state = 'suspended';
    readonly sampleRate = 44100;
    readonly destination = {};
    readonly audioWorklet = {
      addModule: async () => {
        log.push('load worklet');
        if (opts.fail === 'worklet') throw new DOMException('Unable to load a worklet module.', 'AbortError');
      },
    };
    constructor() {
      super();
      log.push('new AudioContext');
      ctx = this;
    }
    resume() {
      log.push('resume');
      if (phone.locked) return new Promise<void>(() => undefined);
      this.state = 'running';
      return Promise.resolve();
    }
    close() {
      log.push('close');
      this.state = 'closed';
      return Promise.resolve();
    }
    createMediaStreamSource = () => ({ connect: () => undefined });
    createGain = () => ({ gain: { value: 1 }, connect: (n: unknown) => n });
    createBuffer = () => ({ copyToChannel: () => undefined });
    createBufferSource = () => {
      const sound = {
        buffer: null,
        onended: null as (() => void) | null,
        connect: (n: unknown) => n,
        disconnect: () => void log.push('cut loose'),
        start: () => void log.push('sound starts'),
      };
      sounds.push(sound);
      return sound;
    };
  }
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', class { port = {}; connect = (n: unknown) => n; });
  vi.stubGlobal('document', page);
  vi.stubGlobal('navigator', {
    locks,
    mediaDevices: {
      getUserMedia: async () => {
        log.push('ask for the microphone');
        if (opts.fail === 'microphone') throw new DOMException('Permission denied', 'NotAllowedError');
        return { getTracks: () => [{ stop: () => log.push('microphone off') }] };
      },
    },
  });
  return { log, page, phone, ctx: () => ctx!, sound: () => sounds.at(-1)! };
}

describe('starting the microphone', () => {
  it('makes and wakes audio within the tap, before the microphone prompt', async () => {
    const { log } = browser();
    const started = new MicTransport().start(() => undefined);
    // Everything so far ran before start()'s first await, so still inside the tap.
    expect(log).toEqual(['new AudioContext', 'resume', 'ask for the microphone']);
    await expect(started).resolves.toBe(44100);
    expect(log.slice(3)).toEqual(['resume', 'load worklet']);
  });

  it.each(['microphone', 'worklet'] as const)('lets go of the microphone and audio when the %s fails', async (fail) => {
    const { log } = browser({ fail });
    await expect(new MicTransport().start(() => undefined)).rejects.toThrow();
    expect(log.slice(-2)).toEqual(fail === 'worklet' ? ['microphone off', 'close'] : ['ask for the microphone', 'close']);
  });

  it('will not listen while another page of this browser listens, and lets go of what it took', async () => {
    const { log } = browser({ otherPageListens: true });
    await expect(new MicTransport().start(() => undefined)).rejects.toMatchObject({ name: 'CannotListen', lack: 'elsewhere' });
    expect(log).toEqual(['new AudioContext', 'resume', 'ask for the microphone', 'microphone off', 'close']);
  });

  it('a page that tries again after a refused microphone is not taken for another page', async () => {
    const opts: { fail?: 'microphone' } = { fail: 'microphone' };
    const { log } = browser(opts);
    const mic = new MicTransport();
    await expect(mic.start(() => undefined)).rejects.toThrow('Permission denied');
    opts.fail = undefined;
    await expect(mic.start(() => undefined)).resolves.toBe(44100);
    expect(log.at(-1)).toBe('load worklet');
  });

  it.each([
    ['AudioWorkletNode', undefined, 'unsupported'],
    ['AudioContext', undefined, 'unsupported'],
    ['navigator', {}, 'unsupported'],
    ['isSecureContext', false, 'insecure'],
  ])('asks for nothing on a page without %s', async (name, value, lack) => {
    const { log } = browser();
    vi.stubGlobal(name, value);
    await expect(new MicTransport().start(() => undefined)).rejects.toMatchObject({ name: 'CannotListen', lack });
    expect(log).toEqual([]);
  });
});

describe('audio the phone took away', () => {
  it("is asked back when Safari reports it 'interrupted', on return to the page, and at the next tap", async () => {
    const { log, page, ctx } = browser();
    await new MicTransport().start(() => undefined);
    const resumes = () => log.filter((l) => l === 'resume').length;
    const before = resumes();
    // A phone call: Safari's own state, outside the standard three.
    ctx().state = 'interrupted';
    ctx().dispatchEvent(new Event('statechange'));
    expect(resumes()).toBe(before + 1);
    ctx().state = 'suspended';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(resumes()).toBe(before + 2);
    ctx().state = 'suspended';
    page.dispatchEvent(new Event('pointerup'));
    expect(resumes()).toBe(before + 3);
    // Running audio is left alone.
    page.dispatchEvent(new Event('keydown'));
    expect(resumes()).toBe(before + 3);
  });

  it('a sound that ends says it played; one cut short when the screen locks says it did not, and is cut loose so it cannot play late', async () => {
    vi.useFakeTimers();
    const { log, ctx, sound } = browser();
    const mic = new MicTransport();
    await mic.start(() => undefined);
    const second = new Float32Array(44100);
    const whole = mic.play(second, 44100);
    sound().onended!();
    await expect(whole).resolves.toBe(true);

    const cut = mic.play(second, 44100);
    // The phone suspends audio partway through, and a suspended sound never ends.
    ctx().state = 'suspended';
    expect(mic.suspended).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(cut).resolves.toBe(false);
    expect(log.slice(-2)).toEqual(['sound starts', 'cut loose']);
  });

  it('a sound asked for while the phone keeps audio suspended is not started, and says it did not play', async () => {
    vi.useFakeTimers();
    const { log, ctx, phone } = browser();
    const mic = new MicTransport();
    await mic.start(() => undefined);
    phone.locked = true;
    ctx().state = 'suspended';
    const played = mic.play(new Float32Array(44100), 44100);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(played).resolves.toBe(false);
    expect(log.at(-1)).toBe('resume');
  });
});
