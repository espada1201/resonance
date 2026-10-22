import { AirLink, type Spectrum } from './audio/link';
import { decodeRecording, renderWav } from './audio/recording';
import type { AirTransport } from './audio/transport';
import { type Circle, SEAL_OVERHEAD, deriveCircle, open, seal } from './mesh/crypto';
import { FILE_REQUEST_TTL, type FileRequest, FileTransfer } from './mesh/files';
import { MeshNode, storeKey } from './mesh/node';
import { BROADCAST, HEADER_LEN, type Packet, PacketType, decodePacket, randomNodeId, randomU32 } from './mesh/packet';
import { type Body, type Geo, type Status, decodeBody, encodeBody, nowSec, typeOf } from './mesh/payloads';
import { TxQueue } from './mesh/radio';
import { MAX_PAYLOAD } from './modem/framing';
import { airtimeSec, modulate } from './modem/modulator';
import { PROFILES, type ProfileId } from './modem/profiles';
import type { DecodedFrame } from './modem/receiver';
import { SavedState, loadStore, safeStorage, saveStore } from './persist';
import { Ranger } from './ranger';

// The station is the whole app minus pixels: it owns the link to the air (speaker, microphone
// and demodulator worker), the mesh node, the transmit queue, encryption and persistence.

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
  /** For direct messages. 'unknown': the app was closed while waiting for the receipt. */
  delivery?: 'sending' | 'acked' | 'failed' | 'unknown';
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

export interface Settings {
  nick: string;
  profile: ProfileId;
  relay: boolean;
  volume: number;
  passphrase: string;
  /** Answer other devices' Find (distance) requests. */
  answerFind: boolean;
}

const DEFAULT_TTL = 5;
/** Listening time after our own frame before the next may start (the worker's busy flag needs a few hundred ms). */
const LISTEN_AFTER_SEND_MS = 400;
const HELLO_MS: Record<Role, number> = { phone: 5 * 60_000, beacon: 60_000 };
/** Hellos are at least this far apart; a neighbour who just turned up gets one back within seconds. */
const GREET_GAP_MS = 30_000;
const TYPE_LABEL: Record<number, string> = { 1: 'message', 2: 'check-in', 3: 'contact', 4: 'file chunk', 5: 'ack', 6: 'hello', 7: 'file request', 8: 'ranging' };

export class Station {
  readonly id: number;
  settings: Settings;
  feed: FeedItem[] = [];
  air: AirEvent[] = [];
  status: 'idle' | 'starting' | 'listening' | 'error' = 'idle';
  error = '';
  position: Geo | null = null;
  totals = { rxBits: 0, rxSec: 0, txSec: 0, lost: 0 };
  readonly mesh: MeshNode;
  readonly radio: TxQueue;
  readonly ranger: Ranger;
  readonly files: FileTransfer;
  readonly startedAt = Date.now();

  private readonly link: AirLink;
  private circle: Circle | null = null;
  private listeners = new Set<() => void>();
  private airSeq = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHello = 0;
  private greeting: ReturnType<typeof setTimeout> | null = null;
  private frameInFlight: DecodedFrame | null = null;
  private readonly saved: SavedState;

  constructor(
    readonly transport: AirTransport,
    readonly role: Role,
    storage: Storage | null = safeStorage(),
  ) {
    this.saved = new SavedState(storage, role);
    this.id = this.saved.load('identity')?.id ?? randomNodeId();
    this.settings = {
      nick: '',
      profile: 'audible',
      relay: true,
      volume: 1,
      passphrase: '',
      answerFind: true,
      ...this.saved.load('settings'),
    };
    if (role === 'beacon') this.settings.relay = true;
    this.link = new AirLink(transport, {
      frame: (f) => this.onFrame(f),
      sync: (profile) => this.logAir({ dir: 'sync', profile, label: 'preamble heard' }),
      lost: (profile, stage) => {
        this.totals.lost++;
        this.logAir({ dir: 'lost', profile, label: stage === 'header' ? 'header unreadable' : 'too damaged to repair' });
      },
      ping: (pos, rho) => this.ranger.onPing(pos, rho),
      changed: () => this.changed(),
      failed: (message) => {
        this.status = 'error';
        this.error = message;
        this.changed();
      },
    });
    const clock = { now: () => Date.now(), random: Math.random };
    this.files = new FileTransfer(this.id, clock);
    this.mesh = new MeshNode(this.id, clock, {
      transmit: (bytes, reason) => this.radio.enqueue(bytes, reason === 'ack'),
      deliver: (p) => void this.onDeliver(p),
      delivery: (msgId, ok) => this.onDelivery(msgId, ok),
      channelBusy: () => this.busy,
      // A receipt says "read": not for a message sealed for another circle (as far as its one-byte tag tells).
      readable: (p) => !p.encrypted || p.channel === this.circle?.channel,
      heardHello: (newcomer) => this.onHello(newcomer),
    });
    if (role === 'beacon') this.mesh.config.backoffMs = [400, 2500];
    this.radio = new TxQueue(
      {
        busy: () => this.link.busy,
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
      sampleRate: () => this.link.sampleRate || 48000,
      modulate: (bytes) => modulate(bytes, PROFILES.audible, this.link.sampleRate || 48000),
      playExclusive: (wave, label) => this.playExclusive(wave, label),
      sendUrgent: (bytes) => this.radio.enqueue(bytes, true),
      changed: () => this.changed(),
    });
    this.applySettings();
    this.restore();
    if (this.settings.passphrase) this.setPassphrase(this.settings.passphrase).catch(() => undefined);
    // The browser drops the wake lock whenever the page is hidden; take it back on return.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.status === 'listening' && void this.keepAwake());
  }

  get busy() {
    return this.link.busy || this.radio.onAir;
  }

  /** The profile of a frame coming in, if any. */
  get receiving() {
    return this.link.receiving;
  }

  get transmitting() {
    return this.link.transmitting;
  }

  get circleChannel() {
    return this.circle?.channel ?? null;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  onSpectrum(fn: (s: Spectrum) => void) {
    return this.link.onSpectrum(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
    this.scheduleSave();
  }

  async start() {
    if (this.status === 'listening' || this.status === 'starting') return;
    // Audio is already running and the decoder gave up: only a fresh page starts cleanly.
    if (this.link.sampleRate) return location.reload();
    this.status = 'starting';
    this.error = '';
    this.changed();
    try {
      await this.link.start(this.settings.volume);
      this.status = 'listening';
      void this.keepAwake();
      setInterval(() => {
        this.mesh.tick();
        void this.radio.tick();
        this.files.chase((r) => void this.ask(r));
      }, 200);
      setTimeout(() => this.hello(), 1500 + Math.random() * 3000);
      setInterval(() => this.hello(), HELLO_MS[this.role] * (0.85 + Math.random() * 0.3));
    } catch (err) {
      this.status = 'error';
      this.error = AirLink.explain(err);
    }
    this.changed();
  }

  /** Announces what we hold, unless a hello went out moments ago (a greeting, say). */
  private hello() {
    if (Date.now() - this.lastHello < GREET_GAP_MS) return;
    this.lastHello = Date.now();
    this.mesh.hello(this.settings.nick, this.role);
  }

  /**
   * A newcomer is in earshot. One hello from this room tells it what the room holds, so whatever it
   * carries that we lack comes over now, not at its next hello minutes later. A neighbour we
   * already know shares our news, so its hello does the same job and ours stands down.
   */
  private onHello(newcomer: boolean) {
    if (!newcomer) {
      if (this.greeting) clearTimeout(this.greeting);
      this.greeting = null;
      return;
    }
    if (this.greeting || Date.now() - this.lastHello < GREET_GAP_MS) return;
    const greet = () => {
      // Wait for clear air, so that a greeting already under way can stand ours down.
      if (this.busy) return void (this.greeting = setTimeout(greet, 500 + Math.random() * 1500));
      this.greeting = null;
      this.hello();
    };
    this.greeting = setTimeout(greet, 1000 + Math.random() * 8000);
  }

  /** Phones stop the microphone when the screen locks, so a listening station keeps it on. */
  private async keepAwake() {
    try {
      await navigator.wakeLock?.request('screen');
    } catch {
      // Unsupported, or refused in battery saver: everything still works while the screen is on.
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
    const fs = this.link.sampleRate || 48000;
    const p = decodePacket(bytes);
    const label = p ? `${TYPE_LABEL[p.type]}${p.src === this.id ? '' : ` relayed for ${nodeHex(p.src)}`}` : 'frame';
    await this.playWave(modulate(bytes, PROFILES[profile], fs), profile, label, bytes.length);
    // We were deaf while sending. Listen for a moment before the queue may send again, so carrier
    // sense can hear a neighbour who started meanwhile.
    await new Promise((r) => setTimeout(r, this.link.muteTailMs + LISTEN_AFTER_SEND_MS));
  }

  private playWave(wave: Float32Array, profile: ProfileId, label: string, bytes?: number) {
    return this.link.play(wave, profile, (seconds) => {
      this.logAir({ dir: 'tx', profile, label, bytes, airtimeSec: seconds });
      this.totals.txSec += seconds;
    });
  }

  /** Plays audio ahead of the queue once the speaker and the air are free (used by Find). */
  private async playExclusive(wave: Float32Array, label: string) {
    this.radio.paused = true;
    try {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      while (this.radio.onAir) await sleep(50);
      for (let waited = 0; this.link.busy && waited < 4000; waited += 100) await sleep(100);
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

  async send(body: Body, opts: { dst?: number; sealed?: boolean; ttl?: number } = {}) {
    const dst = opts.dst ?? BROADCAST;
    // Sealed for our circle, if we are in one, unless asked not to be.
    const circle = (opts.sealed ?? true) ? this.circle : null;
    const plain = encodeBody(body);
    const base: Omit<Packet, 'src' | 'hops' | 'attempt'> = {
      type: typeOf[body.kind],
      encrypted: circle !== null,
      ackRequested: dst !== BROADCAST,
      msgId: randomU32(),
      dst,
      ttl: opts.ttl ?? DEFAULT_TTL,
      channel: circle?.channel ?? 0,
      body: plain,
    };
    if (circle) base.body = await seal(circle, { ...base, src: this.id, hops: 0, attempt: 0 }, plain as Uint8Array<ArrayBuffer>);
    if (HEADER_LEN + base.body.length > MAX_PAYLOAD) throw new Error('That is too long for one sound packet.');
    const p = this.mesh.originate(base);
    if (body.kind === 'file') this.files.sent(body, p.msgId);
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

  sendContact(name: string, phone: string, note: string, dst?: number) {
    return this.send({ kind: 'contact', ts: nowSec(), name, phone, note }, { dst });
  }

  async sendFile(name: string, mime: string, data: Uint8Array) {
    const { key, chunks } = this.files.create(randomU32() & 0xffff, { name, mime }, data);
    this.addFeed({ id: `file:${key}`, src: this.id, msgId: 0, at: Date.now(), hops: 0, mine: true, encrypted: !!this.circle, locked: false, dst: BROADCAST, fileKey: key });
    for (const c of chunks) await this.send(c);
    return key;
  }

  /** Asks the mesh for the chunks of a file we are still missing. */
  requestMissing(key: string) {
    const req = this.files.request(key);
    if (req) return this.ask(req);
  }

  private ask(req: FileRequest) {
    return this.send(req, { sealed: false, ttl: FILE_REQUEST_TTL });
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
      const f = this.files.heard(p.src, body, p.msgId, frame?.airtimeSec ?? 0);
      const id = `file:${f.key}`;
      if (!this.feed.some((i) => i.id === id)) this.addFeed({ ...this.itemBase(p, false), id, fileKey: f.key });
    } else if (body.kind === 'filereq') {
      // Anyone holding a requested chunk may answer; the mesh lets the holder nearest the asker go first.
      for (const msgId of this.files.asked(body)) this.mesh.answer(body.fileSrc, msgId, p.hops);
    } else if (body.kind === 'range') {
      void this.ranger.onPacket(p, body, frame);
    } else if (body.kind === 'text' || body.kind === 'checkin' || body.kind === 'contact') {
      this.addFeed({ ...this.itemBase(p, false), body });
      // Name a neighbour in People and the To menu now, not at its next hello minutes from now.
      const n = this.mesh.neighbors.get(p.src);
      if (n && body.kind !== 'contact' && body.nick) n.nick = body.nick;
    }
    this.changed();
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

  // ---- sound files: any speaker can carry a packet -----------------------------------------

  /** Renders a feed item's packet as a WAV file that any device can play to the mesh. */
  exportWav(item: FeedItem): Blob | null {
    const s = this.mesh.store.get(storeKey(item));
    return s ? renderWav(s.bytes, PROFILES[this.settings.profile]) : null;
  }

  /** Decodes every packet found in a recording (any format the browser can decode). */
  async importRecording(data: ArrayBuffer): Promise<number> {
    const frames = await decodeRecording(data);
    frames.forEach((f) => this.onFrame(f));
    return frames.length;
  }

  // ---- settings & persistence --------------------------------------------------------------

  update(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.applySettings();
    if (patch.volume !== undefined) this.link.setVolume(patch.volume);
    this.changed();
  }

  /** Puts the settings in force. The volume has its own path: the speaker exists only once started. */
  private applySettings() {
    this.mesh.config.relay = this.role === 'beacon' || this.settings.relay;
    this.ranger.answering = this.settings.answerFind;
  }

  /** Joins (or with "" leaves) a circle. Throws where the browser offers no crypto (plain http). */
  async setPassphrase(passphrase: string) {
    const circle = passphrase ? await deriveCircle(passphrase) : null;
    this.settings.passphrase = passphrase;
    this.circle = circle;
    this.changed();
  }

  private scheduleSave() {
    if (this.saveTimer || !this.saved.available) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 800);
  }

  save() {
    this.saved.save({
      identity: { id: this.id },
      settings: this.settings,
      feed: this.feed.slice(0, 200),
      store: saveStore(this.mesh.store.values()),
      ...this.files.snapshot(),
    });
  }

  private restore() {
    const saved = this.saved;
    // Retry timers do not survive a reload; a late receipt can still turn these into "delivered".
    this.feed = (saved.load('feed') ?? []).map((i) => (i.delivery === 'sending' ? { ...i, delivery: 'unknown' } : i));
    this.mesh.hydrate(loadStore(saved.load('store') ?? []));
    this.files.restore({ files: saved.load('files') ?? [], chunks: saved.load('chunks') ?? [] });
  }

  /** Forgets everything heard (keeps identity and settings). */
  wipe() {
    this.feed = [];
    this.air = [];
    this.files.clear();
    this.mesh.store.clear();
    this.changed();
  }
}

export const nodeHex = (id: number) => id.toString(16).padStart(6, '0').toUpperCase();

