import type { FromWorker, ToWorker } from './audio/protocol';
import type { AirTransport } from './audio/transport';
import { type Circle, SEAL_OVERHEAD, deriveCircle, open, seal } from './mesh/crypto';
import { type FileState, addChunk, assemble, chunkFile, fileKey, missing } from './mesh/files';
import { MeshNode, type StoredPacket } from './mesh/node';
import { BROADCAST, HEADER_LEN, type Packet, PacketType, decodePacket, randomNodeId, randomU32 } from './mesh/packet';
import { type Body, type Geo, type Status, decodeBody, encodeBody, nowSec, typeOf } from './mesh/payloads';
import { TxQueue } from './mesh/radio';
import { wav } from './modem/channel-sim';
import { MAX_PAYLOAD } from './modem/framing';
import { airtimeSec, modulate } from './modem/modulator';
import { PROFILES, type ProfileId } from './modem/profiles';
import { type DecodedFrame, Receiver } from './modem/receiver';
import { Ranger } from './ranger';

// The station is the whole app minus pixels: it owns the audio transport, the demodulator
// worker, the mesh node, the transmit queue, encryption and persistence.

type Role = 'phone' | 'beacon';
type ContentBody = Extract<Body, { kind: 'text' | 'checkin' | 'contact' }>;

export interface FeedItem {
  id: string;
  src: number;
  msgId: number;
  at: number;
  hops: number;
  mine: boolean;
  encrypted: boolean;
  /** Sealed for a circle whose passphrase we do not have. */
  locked: boolean;
  dst: number;
  body?: ContentBody;
  fileKey?: string;
  delivery?: 'sending' | 'acked' | 'failed';
}

export interface AirEvent {
  id: number;
  at: number;
  dir: 'rx' | 'tx' | 'sync' | 'lost';
  profile: ProfileId;
  label: string;
  bytes?: number;
  airtimeSec?: number;
  toneSnrDb?: number;
  corrected?: number;
  clockRatio?: number;
}

interface Settings {
  nick: string;
  profile: ProfileId;
  relay: boolean;
  volume: number;
  passphrase: string;
  /** Answer other devices' Find (distance) requests. */
  answerFind: boolean;
}

interface Spectrum {
  bins: Float32Array;
  fs: number;
}

const DEFAULT_TTL = 5;
/** Listening time after our own frame before the next may start (the worker's busy flag needs a few hundred ms). */
const LISTEN_AFTER_SEND_MS = 400;
/** Someone else's file that goes quiet this long asks for its missing pieces (random, so a crowd does not ask at once). */
const FILE_PATIENCE_MS: [number, number] = [20_000, 35_000];
/** Automatic asks per file; after that the feed's "Ask for missing" button is left. */
const AUTO_ASKS = 3;
const HELLO_MS: Record<Role, number> = { phone: 5 * 60_000, beacon: 60_000 };
const KEY = 'resonance:v1:';
const TYPE_LABEL: Record<number, string> = { 1: 'message', 2: 'check-in', 3: 'contact', 4: 'file chunk', 5: 'ack', 6: 'hello', 7: 'file request', 8: 'ranging' };

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function load<T>(storage: Storage | null, key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export class Station {
  readonly id: number;
  settings: Settings;
  feed: FeedItem[] = [];
  air: AirEvent[] = [];
  files = new Map<string, FileState>();
  status: 'idle' | 'starting' | 'listening' | 'error' = 'idle';
  error = '';
  receiving: ProfileId | null = null;
  transmitting: { profile: ProfileId; seconds: number; started: number } | null = null;
  sampleRate = 0;
  position: Geo | null = null;
  totals = { rxBits: 0, rxSec: 0, txSec: 0, lost: 0 };
  readonly mesh: MeshNode;
  readonly radio: TxQueue;
  readonly ranger: Ranger;
  readonly startedAt = Date.now();

  private circle: Circle | null = null;
  private worker: Worker | null = null;
  private workerBusy = false;
  private listeners = new Set<() => void>();
  private spectrumListeners = new Set<(s: Spectrum) => void>();
  private chunkIds = new Map<string, Map<number, number>>();
  private airSeq = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private unmute: ReturnType<typeof setTimeout> | null = null;
  private fileWaits = new Map<string, { due: number; asks: number }>();
  private frameInFlight: DecodedFrame | null = null;
  private readonly prefix: string;

  constructor(
    readonly transport: AirTransport,
    readonly role: Role,
    private readonly storage: Storage | null = safeStorage(),
  ) {
    this.prefix = `${KEY}${role}:`;
    const ident = load<{ id: number }>(storage, this.prefix + 'identity');
    this.id = ident?.id ?? randomNodeId();
    this.settings = {
      nick: '',
      profile: 'audible',
      relay: true,
      volume: 1,
      passphrase: '',
      answerFind: true,
      ...load<Partial<Settings>>(storage, this.prefix + 'settings'),
    };
    if (role === 'beacon') this.settings.relay = true;
    const clock = { now: () => Date.now(), random: Math.random };
    this.mesh = new MeshNode(this.id, clock, {
      transmit: (bytes, reason) => this.radio.enqueue(bytes, reason === 'ack'),
      deliver: (p) => void this.onDeliver(p),
      delivery: (msgId, ok) => this.onDelivery(msgId, ok),
      channelBusy: () => this.busy,
    });
    this.mesh.config.relay = this.settings.relay;
    if (role === 'beacon') this.mesh.config.backoffMs = [400, 2500];
    this.radio = new TxQueue(
      {
        busy: () => this.workerBusy,
        send: (b) => this.sendFrame(b),
        finished: (b) => {
          this.mesh.aired(b);
          this.changed();
        },
      },
      clock,
    );
    this.ranger = new Ranger({
      id: this.id,
      sampleRate: () => this.sampleRate || 48000,
      modulate: (bytes) => modulate(bytes, PROFILES.audible, this.sampleRate || 48000),
      playExclusive: (wave, label) => this.playExclusive(wave, label),
      sendUrgent: (bytes) => this.radio.enqueue(bytes, true),
      changed: () => this.changed(),
    });
    this.ranger.answering = this.settings.answerFind;
    this.restore();
    if (this.settings.passphrase) void this.setPassphrase(this.settings.passphrase);
    // The browser drops the wake lock whenever the page is hidden; take it back on return.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.status === 'listening' && void this.keepAwake());
  }

  get busy() {
    return this.workerBusy || this.radio.onAir;
  }

  get circleChannel() {
    return this.circle?.channel ?? null;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  onSpectrum(fn: (s: Spectrum) => void) {
    this.spectrumListeners.add(fn);
    return () => void this.spectrumListeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
    this.scheduleSave();
  }

  async start() {
    if (this.status === 'listening' || this.status === 'starting') return;
    this.status = 'starting';
    this.error = '';
    this.changed();
    try {
      this.worker = new Worker(new URL('./audio/rx-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
      this.sampleRate = await this.transport.start((chunk) => this.toWorker({ type: 'samples', data: chunk }, [chunk.buffer]));
      this.transport.setVolume(this.settings.volume);
      this.toWorker({ type: 'init', sampleRate: this.sampleRate });
      this.status = 'listening';
      void this.keepAwake();
      setInterval(() => {
        this.mesh.tick();
        void this.radio.tick();
        this.chaseFiles();
      }, 200);
      const hello = () => this.mesh.hello(this.settings.nick, this.role);
      setTimeout(hello, 1500 + Math.random() * 3000);
      setInterval(hello, HELLO_MS[this.role] * (0.85 + Math.random() * 0.3));
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.worker?.terminate();
      this.worker = null;
    }
    this.changed();
  }

  /** Phones stop the microphone when the screen locks, so a listening station keeps it on. */
  private async keepAwake() {
    try {
      await navigator.wakeLock?.request('screen');
    } catch {
      // Unsupported, or refused in battery saver: everything still works while the screen is on.
    }
  }

  private toWorker(m: ToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer);
  }

  private onWorker(m: FromWorker) {
    switch (m.type) {
      case 'spectrum':
        for (const fn of this.spectrumListeners) fn(m);
        return;
      case 'busy':
        this.workerBusy = m.busy;
        if (!m.busy) this.receiving = null;
        return this.changed();
      case 'sync':
        this.receiving = m.profile;
        this.logAir({ dir: 'sync', profile: m.profile, label: 'preamble heard' });
        return;
      case 'lost':
        this.receiving = null;
        this.totals.lost++;
        this.logAir({ dir: 'lost', profile: m.profile, label: m.stage === 'header' ? 'header unreadable' : 'too damaged to repair' });
        return;
      case 'ping':
        return this.ranger.onPing(m.pos, m.rho);
      case 'frame':
        this.receiving = null;
        this.onFrame(m.frame);
    }
  }

  /** Feeds a decoded frame (from the air or from a recording) into the mesh. */
  onFrame(f: DecodedFrame) {
    this.totals.rxBits += f.payload.length * 8;
    this.totals.rxSec += f.airtimeSec;
    const p = decodePacket(f.payload);
    this.logAir({
      dir: 'rx',
      profile: f.profile,
      label: !p
        ? 'not a Resonance packet'
        : p.src === this.id
          ? `echo of your ${TYPE_LABEL[p.type]}: a neighbour repeated it`
          : `${TYPE_LABEL[p.type]} from ${nodeHex(p.src)}${p.hops ? ` · hop ${p.hops}` : ''}`,
      bytes: f.payload.length,
      airtimeSec: f.airtimeSec,
      toneSnrDb: f.toneSnrDb,
      corrected: f.corrected,
      clockRatio: f.clockRatio,
    });
    this.frameInFlight = f;
    this.mesh.receive(f.payload);
    this.frameInFlight = null;
    this.changed();
  }

  private async sendFrame(bytes: Uint8Array) {
    const profile = this.settings.profile;
    const fs = this.sampleRate || 48000;
    const p = decodePacket(bytes);
    const label = p ? `${TYPE_LABEL[p.type]}${p.src === this.id ? '' : ` relayed for ${nodeHex(p.src)}`}` : 'frame';
    await this.playWave(modulate(bytes, PROFILES[profile], fs), profile, label, bytes.length);
    // We were deaf while sending. Listen for a moment before the queue may send again, so carrier
    // sense can hear a neighbour who started meanwhile.
    await new Promise((r) => setTimeout(r, this.muteTailMs() + LISTEN_AFTER_SEND_MS));
  }

  /** How long the receiver stays muted after our own frame ends: the tail of our sound still in the capture path. */
  private muteTailMs() {
    return 150 + (this.transport.captureDelayMs ?? 0);
  }

  private async playWave(wave: Float32Array, profile: ProfileId, label: string, bytes?: number) {
    const fs = this.sampleRate || 48000;
    const seconds = wave.length / fs;
    this.transmitting = { profile, seconds, started: Date.now() };
    this.logAir({ dir: 'tx', profile, label, bytes, airtimeSec: seconds });
    this.totals.txSec += seconds;
    // Our own frames would otherwise be decoded as if a neighbour had repeated them. A pending
    // unmute from the previous frame must not cut into this one.
    if (this.unmute) clearTimeout(this.unmute);
    this.toWorker({ type: 'mute', on: true });
    try {
      await this.transport.play(wave, fs);
    } finally {
      this.transmitting = null;
      this.unmute = setTimeout(() => {
        this.unmute = null;
        this.toWorker({ type: 'mute', on: false });
      }, this.muteTailMs());
      this.changed();
    }
  }

  /** Plays audio ahead of the queue once the speaker and the air are free (used by Find). */
  private async playExclusive(wave: Float32Array, label: string) {
    this.radio.paused = true;
    try {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      while (this.radio.onAir) await sleep(50);
      for (let waited = 0; this.workerBusy && waited < 4000; waited += 100) await sleep(100);
      await this.playWave(wave, 'audible', label);
    } finally {
      this.radio.paused = false;
    }
  }

  private logAir(e: Omit<AirEvent, 'id' | 'at'>) {
    this.air = [{ ...e, id: ++this.airSeq, at: Date.now() }, ...this.air].slice(0, 120);
    this.changed();
  }

  // ---- sending -------------------------------------------------------------------------

  /** Bytes left for free text in a message, given the current nick and encryption. */
  textBudget() {
    const nick = new TextEncoder().encode(this.settings.nick).length;
    return MAX_PAYLOAD - HEADER_LEN - (this.circle ? SEAL_OVERHEAD : 0) - 4 - 1 - Math.min(16, nick);
  }

  /** Seconds a body would take on air with the current profile. */
  estimateAirtime(body: Body) {
    const n = HEADER_LEN + encodeBody(body).length + (this.circle ? SEAL_OVERHEAD : 0);
    return airtimeSec(PROFILES[this.settings.profile], Math.min(MAX_PAYLOAD, n));
  }

  async send(body: Body, opts: { dst?: number; sealed?: boolean } = {}) {
    const dst = opts.dst ?? BROADCAST;
    const sealed = (opts.sealed ?? !!this.circle) && !!this.circle;
    const plain = encodeBody(body);
    const base: Omit<Packet, 'src' | 'hops' | 'attempt'> = {
      type: typeOf[body.kind],
      encrypted: sealed,
      ackRequested: dst !== BROADCAST,
      msgId: randomU32(),
      dst,
      ttl: DEFAULT_TTL,
      channel: sealed ? this.circle!.channel : 0,
      body: plain,
    };
    if (sealed) base.body = await seal(this.circle!, { ...base, src: this.id, hops: 0, attempt: 0 }, plain as Uint8Array<ArrayBuffer>);
    if (HEADER_LEN + base.body.length > MAX_PAYLOAD) throw new Error('That is too long for one sound packet.');
    const p = this.mesh.originate(base);
    if (body.kind === 'file') this.trackChunk(this.id, body.fileId, body.index, p.msgId);
    else if (body.kind === 'text' || body.kind === 'checkin' || body.kind === 'contact') {
      this.addFeed({ ...this.itemBase(p, true), body, delivery: dst !== BROADCAST ? 'sending' : undefined });
    }
    this.changed();
    return p;
  }

  sendText(text: string, dst?: number) {
    return this.send({ kind: 'text', ts: nowSec(), nick: this.settings.nick, text }, { dst });
  }

  sendCheckIn(status: Status, note: string, geo?: Geo) {
    return this.send({ kind: 'checkin', ts: nowSec(), nick: this.settings.nick, status, geo, note });
  }

  sendContact(name: string, phone: string, note: string) {
    return this.send({ kind: 'contact', ts: nowSec(), name, phone, note });
  }

  async sendFile(name: string, mime: string, data: Uint8Array) {
    const fileId = randomU32() & 0xffff;
    const chunks = chunkFile(fileId, { name, mime }, data);
    const key = fileKey(this.id, fileId);
    for (const c of chunks) addChunk(this.files, this.id, c);
    this.addFeed({ id: `file:${key}`, src: this.id, msgId: 0, at: Date.now(), hops: 0, mine: true, encrypted: !!this.circle, locked: false, dst: BROADCAST, fileKey: key });
    for (const c of chunks) await this.send(c);
    return key;
  }

  /** Asks the mesh for the chunks of a file we are still missing. */
  requestMissing(key: string) {
    const f = this.files.get(key);
    if (!f) return;
    return this.send({ kind: 'filereq', fileSrc: f.src, fileId: f.fileId, missing: missing(f) }, { sealed: false });
  }

  /** Heard progress on someone else's unfinished file: give it time before asking for the rest. */
  private expectMore(key: string) {
    const f = this.files.get(key);
    if (!f || f.src === this.id || !missing(f).length) {
      this.fileWaits.delete(key);
      return;
    }
    const [lo, hi] = FILE_PATIENCE_MS;
    const w = this.fileWaits.get(key) ?? { due: 0, asks: 0 };
    w.due = Date.now() + lo + Math.random() * (hi - lo);
    this.fileWaits.set(key, w);
  }

  /** Asks for the missing pieces of files that went quiet: a lost chunk is otherwise lost for good. */
  private chaseFiles() {
    const now = Date.now();
    for (const [key, w] of this.fileWaits) {
      if (w.due > now) continue;
      const f = this.files.get(key);
      if (!f || !missing(f).length || w.asks >= AUTO_ASKS) {
        this.fileWaits.delete(key);
        continue;
      }
      w.asks++;
      this.expectMore(key);
      void this.requestMissing(key);
    }
  }

  // ---- receiving -------------------------------------------------------------------------

  private itemBase(p: Packet, mine: boolean): FeedItem {
    return { id: `${p.src}:${p.msgId}`, src: p.src, msgId: p.msgId, at: Date.now(), hops: p.hops, mine, encrypted: p.encrypted, locked: false, dst: p.dst };
  }

  private async onDeliver(p: Packet) {
    const frame = this.frameInFlight;
    let plain: Uint8Array | null = p.body;
    if (p.encrypted) plain = this.circle ? await open(this.circle, p) : null;
    if (!plain) {
      if (p.type !== PacketType.FileChunk) this.addFeed({ ...this.itemBase(p, false), locked: true });
      return this.changed();
    }
    const body = decodeBody(p.type, plain);
    if (!body) return;
    if (body.kind === 'file') {
      this.trackChunk(p.src, body.fileId, body.index, p.msgId);
      const f = addChunk(this.files, p.src, body);
      this.expectMore(f.key);
      const id = `file:${f.key}`;
      if (!this.feed.some((i) => i.id === id)) this.addFeed({ ...this.itemBase(p, false), id, fileKey: f.key });
    } else if (body.kind === 'filereq') {
      // Someone already asked for a file we are missing too: their answer may fill our gaps.
      const k = fileKey(body.fileSrc, body.fileId);
      if (this.fileWaits.has(k)) this.expectMore(k);
      this.answerFileRequest(body.fileSrc, body.fileId, body.missing);
    } else if (body.kind === 'range') {
      void this.ranger.onPacket(p, body, frame);
    } else if (body.kind === 'text' || body.kind === 'checkin' || body.kind === 'contact') {
      this.addFeed({ ...this.itemBase(p, false), body });
    }
    this.changed();
  }

  private answerFileRequest(fileSrc: number, fileId: number, want: number[]) {
    // The author and beacons answer; everyone else lets them, to keep the air quiet.
    if (fileSrc !== this.id && this.role !== 'beacon') return;
    const ids = this.chunkIds.get(fileKey(fileSrc, fileId));
    if (!ids) return;
    for (const i of want.slice(0, 8)) {
      const msgId = ids.get(i);
      if (msgId !== undefined) this.mesh.resend(fileSrc, msgId);
    }
  }

  private trackChunk(src: number, fileId: number, index: number, msgId: number) {
    const k = fileKey(src, fileId);
    if (!this.chunkIds.has(k)) this.chunkIds.set(k, new Map());
    this.chunkIds.get(k)!.set(index, msgId);
  }

  private onDelivery(msgId: number, ok: boolean) {
    const item = this.feed.find((i) => i.mine && i.msgId === msgId);
    if (item) item.delivery = ok ? 'acked' : 'failed';
    this.changed();
  }

  private addFeed(item: FeedItem) {
    if (this.feed.some((i) => i.id === item.id)) return;
    this.feed = [item, ...this.feed].slice(0, 400);
  }

  setPosition(geo: Geo) {
    this.position = geo;
    this.changed();
  }

  fileData(key: string) {
    const f = this.files.get(key);
    return f ? assemble(f) : null;
  }

  // ---- sound files: any speaker can carry a packet -----------------------------------------

  /** Renders a feed item's packet as a WAV file that any device can play to the mesh. */
  exportWav(item: FeedItem): Blob | null {
    const s = this.mesh.store.get(`${item.src}:${item.msgId}`);
    if (!s) return null;
    const fs = 48000;
    const wave = modulate(s.bytes, PROFILES[this.settings.profile], fs);
    const padded = new Float32Array(wave.length + fs / 2);
    padded.set(wave, fs / 4);
    return new Blob([wav(padded, fs) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
  }

  /** Decodes every packet found in a recording (any format the browser can decode). */
  async importRecording(data: ArrayBuffer): Promise<number> {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const audio = await ctx.decodeAudioData(data);
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    const frames: DecodedFrame[] = [];
    const rx = new Receiver(audio.sampleRate, Object.values(PROFILES), { frame: (f) => frames.push(f) });
    for (let i = 0; i < mono.length; i += 4096) rx.push(mono.subarray(i, i + 4096));
    rx.push(new Float32Array(audio.sampleRate));
    frames.forEach((f) => this.onFrame(f));
    return frames.length;
  }

  // ---- settings & persistence --------------------------------------------------------------

  update(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    if (patch.relay !== undefined) this.mesh.config.relay = this.role === 'beacon' || patch.relay;
    if (patch.volume !== undefined) this.transport.setVolume(patch.volume);
    if (patch.answerFind !== undefined) this.ranger.answering = patch.answerFind;
    this.changed();
  }

  async setPassphrase(passphrase: string) {
    this.settings.passphrase = passphrase;
    this.circle = passphrase ? await deriveCircle(passphrase) : null;
    this.changed();
  }

  private scheduleSave() {
    if (this.saveTimer || !this.storage) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 800);
  }

  save() {
    const s = this.storage;
    if (!s) return;
    try {
      s.setItem(this.prefix + 'identity', JSON.stringify({ id: this.id }));
      s.setItem(this.prefix + 'settings', JSON.stringify(this.settings));
      s.setItem(this.prefix + 'feed', JSON.stringify(this.feed.slice(0, 200)));
      s.setItem(
        this.prefix + 'store',
        JSON.stringify([...this.mesh.store.values()].map((p) => ({ b: b64(p.bytes), t: p.firstHeard }))),
      );
      s.setItem(
        this.prefix + 'files',
        JSON.stringify(
          [...this.files.values()].map((f) => ({ ...f, chunks: f.chunks.map((c) => (c ? b64(c) : null)) })),
        ),
      );
      s.setItem(this.prefix + 'chunks', JSON.stringify([...this.chunkIds].map(([k, m]) => [k, [...m]])));
    } catch {
      // Storage full or blocked: the app keeps working in memory.
    }
  }

  private restore() {
    const s = this.storage;
    const k = this.prefix;
    this.feed = load<FeedItem[]>(s, k + 'feed') ?? [];
    const store = load<Array<{ b: string; t: number }>>(s, k + 'store') ?? [];
    this.mesh.hydrate(store.map((x): StoredPacket => ({ bytes: unb64(x.b), firstHeard: x.t, lastPushed: -Infinity })));
    for (const f of load<Array<Omit<FileState, 'chunks'> & { chunks: Array<string | null> }>>(s, k + 'files') ?? []) {
      this.files.set(f.key, { ...f, chunks: f.chunks.map((c) => (c ? unb64(c) : undefined)) });
    }
    for (const [fk, m] of load<Array<[string, Array<[number, number]>]>>(s, k + 'chunks') ?? []) this.chunkIds.set(fk, new Map(m));
  }

  /** Forgets everything heard (keeps identity and settings). */
  wipe() {
    this.feed = [];
    this.air = [];
    this.files.clear();
    this.chunkIds.clear();
    this.mesh.store.clear();
    this.changed();
  }
}

export const nodeHex = (id: number) => id.toString(16).padStart(6, '0').toUpperCase();

function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    s.setItem(KEY + 'probe', '1');
    s.removeItem(KEY + 'probe');
    return s;
  } catch {
    return null;
  }
}

