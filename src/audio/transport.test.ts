import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicTransport } from './transport';

afterEach(() => {
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
  return { log, page, ctx: () => ctx! };
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
});
