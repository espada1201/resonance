import { AirLink, type Spectrum } from './audio/link';
import { decodeRecording, renderWav } from './audio/recording';
import type { AirTransport } from './audio/transport';
import { type FeedItem, Journal, type Meta } from './journal';
import { type Circle, SEAL_OVERHEAD, deriveCircle, open, seal } from './mesh/crypto';
import { FILE_REQUEST_TTL, type FileRequest, FileTransfer, chunkFile } from './mesh/files';
import { FIRST_RESEND_MS, MeshNode, isLasting, storeKey } from './mesh/node';
import { BROADCAST, HEADER_LEN, PACKET_LABEL, type Packet, PacketType, decodePacket, nodeHex, peekType, randomNodeId, randomU32 } from './mesh/packet';
import { type Body, type ContentBody, type Geo, type ReplyKind, decodeBody, encodeBody, isContent, nowSec, typeOf } from './mesh/payloads';
import { TxQueue } from './mesh/radio';
import { MAX_PAYLOAD } from './modem/framing';
import { airtimeSec, modulate } from './modem/modulator';
import { PROFILES, type ProfileId, playableAt } from './modem/profiles';
import type { DecodedFrame } from './modem/receiver';
import { SavedState, loadStore, safeStorage, saveStore } from './persist';
import { Ranger } from './ranger';
import type { CheckInBody, Heard } from './roster';
import { Links } from './signal';

// The station is the whole app minus pixels: it owns the link to the air (speaker, microphone
// and demodulator worker), the mesh node, the transmit queue, encryption and persistence.

export type Role = 'phone' | 'beacon';
type Unstamped<B> = B extends unknown ? Omit<B, 'ts' | 'nick'> : never;
/** What a person writes. The station adds their name and the time as it sends. */
export type Draft = Unstamped<ContentBody>;

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
  /** One of ours that paused sound cut short: it did not go out whole. */
  cut?: boolean;
}

export interface Settings {
  nick: string;
  profile: ProfileId;
  relay: boolean;
  volume: number;
  passphrase: string;
  /** Answer other devices' Find (distance) requests. */
  answerFind: boolean;
  /** From your last check-in about yourself: the next one starts from them, and a one-tap check-in carries them. */
  place: string;
  outside: string;
}

const DEFAULT_TTL = 5;
/** Listening time after our own frame before the next may start (the worker's busy flag needs a few hundred ms). */
const LISTEN_AFTER_SEND_MS = 400;
const HELLO_MS: Record<Role, number> = { phone: 5 * 60_000, beacon: 60_000 };
/** Hellos are at least this far apart; a neighbour who just turned up gets one back within seconds. */
const GREET_GAP_MS = 30_000;
/** A receipt for an answer to our request is said again after this long, and up to as long again. */
const ACK_AGAIN_MS = 8_000;

export class Station {
  readonly id: number;
  settings: Settings;
  air: AirEvent[] = [];
  status: 'idle' | 'starting' | 'listening' | 'error' = 'idle';
  error = '';
  position: Geo | null = null;
  totals = { rxBits: 0, rxSec: 0, txSec: 0, lost: 0 };
  readonly mesh: MeshNode;
  readonly radio: TxQueue;
  readonly ranger: Ranger;
  readonly files: FileTransfer;
  /** Everything said on the mesh that this device knows: the feed and the safety log. */
  readonly journal: Journal;
  /** How well each neighbour comes across. Kept in memory only. */
  readonly links = new Links();
  readonly startedAt = Date.now();

  private readonly link: AirLink;
  private circle: Circle | null = null;
  /** Settles once the circle being joined has its key, or failed to get one. */
  private joining: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private airSeq = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHello = 0;
  private greeting: ReturnType<typeof setTimeout> | null = null;
  private frameInFlight: DecodedFrame | null = null;
  /** Whether the frame in flight was heard just now, rather than found in a recording. */
  private frameLive = false;
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
      place: '',
      outside: '',
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
    this.journal = new Journal(this.id, clock);
    this.mesh = new MeshNode(this.id, clock, {
      transmit: (bytes, reason) => this.radio.enqueue(bytes, reason === 'ack'),
      deliver: (p) => void this.onDeliver(p),
      delivery: (msgId, ok, from) => {
        this.journal.delivered(msgId, ok, from);
        this.changed();
      },
      passedOn: (msgId) => {
        // A recording can hold our own sound: only a copy heard on the air is another phone's.
        if (!this.frameLive) return;
        this.journal.passedOn(msgId);
        this.changed();
      },
      channelBusy: () => this.busy,
      // A receipt says "read": not for a message sealed for another circle (as far as its one-byte tag tells).
      readable: (p) => !p.encrypted || p.channel === this.circle?.channel,
      heardHello: (newcomer) => this.onHello(newcomer),
    });
    if (role === 'beacon') this.mesh.config.backoffMs = [400, 2500];
    this.radio = new TxQueue(
      {
        busy: () => this.link.busy,
        suspended: () => this.link.suspended,
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
      sampleRate: () => this.link.rate,
      modulate: (bytes) => modulate(bytes, PROFILES.audible, this.link.rate),
      playExclusive: (wave, label) => this.playExclusive(wave, label),
      sendUrgent: (bytes) => this.radio.enqueue(bytes, true),
      changed: () => this.changed(),
    });
    this.applySettings();
    this.restore();
    if (this.settings.passphrase) this.setPassphrase(this.settings.passphrase).catch(() => undefined);
    // A hidden page may be frozen or closed before a pending save runs, so it runs now. The browser
    // drops the wake lock whenever the page is hidden; take it back on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushSave();
      else if (this.status === 'listening') void this.keepAwake();
    });
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

  /** The device has paused its sound (a locked screen, a call): nothing is heard or sent until it is back. */
  get suspended() {
    return this.link.suspended;
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
    if (this.link.running) return location.reload();
    this.status = 'starting';
    this.error = '';
    this.changed();
    try {
      await this.link.start(this.settings.volume);
      this.status = 'listening';
      void this.keepAwake();
      let paused = false;
      setInterval(() => {
        this.mesh.tick();
        void this.radio.tick();
        this.files.chase((r) => void this.ask(r));
        if (this.suspended !== paused) {
          paused = this.suspended;
          this.changed();
        }
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

  /** Feeds a decoded frame into the mesh: one heard `live`, or one found in a recording. */
  onFrame(f: DecodedFrame, live = true) {
    this.totals.rxBits += f.payload.length * 8;
    this.totals.rxSec += f.airtimeSec;
    const p = decodePacket(f.payload);
    // Only a frame its sender aired just now says how well we hear that sender.
    if (p && live && p.hops === 0 && p.src !== this.id) this.links.add(p.src, { profile: f.profile, snrDb: f.toneSnrDb, at: Date.now() });
    this.logAir({
      dir: 'rx',
      profile: f.profile,
      label: !p
        ? 'not a Resonance packet'
        : p.src === this.id
          ? `echo of your ${PACKET_LABEL[p.type]}: a neighbour repeated it`
          : `${PACKET_LABEL[p.type]} from ${nodeHex(p.src)}${p.hops ? ` · hop ${p.hops}` : ''}`,
      bytes: f.payload.length,
      airtimeSec: f.airtimeSec,
      toneSnrDb: f.toneSnrDb,
      corrected: f.corrected,
      clockRatio: f.clockRatio,
    });
    this.frameInFlight = f;
    this.frameLive = live;
    this.mesh.receive(f.payload);
    this.frameInFlight = null;
    this.changed();
  }

  playable(id: ProfileId) {
    return playableAt(PROFILES[id], this.link.rate);
  }

  private get sendProfile(): ProfileId {
    return this.playable(this.settings.profile) ? this.settings.profile : 'audible';
  }

  private async sendFrame(bytes: Uint8Array) {
    const profile = this.sendProfile;
    const fs = this.link.rate;
    const p = decodePacket(bytes);
    const label = p ? `${PACKET_LABEL[p.type]}${p.src === this.id ? '' : ` relayed for ${nodeHex(p.src)}`}` : 'frame';
    const played = await this.playWave(modulate(bytes, PROFILES[profile], fs), profile, label, bytes.length);
    // We were deaf while sending. Listen for a moment before the queue may send again, so carrier
    // sense can hear a neighbour who started meanwhile.
    await new Promise((r) => setTimeout(r, this.link.muteTailMs + LISTEN_AFTER_SEND_MS));
    return played;
  }

  private async playWave(wave: Float32Array, profile: ProfileId, label: string, bytes?: number) {
    let id = 0;
    const played = await this.link.play(wave, profile, (seconds) => {
      id = this.logAir({ dir: 'tx', profile, label, bytes, airtimeSec: seconds });
      this.totals.txSec += seconds;
    });
    if (!played) {
      this.air = this.air.map((e) => (e.id === id ? { ...e, cut: true } : e));
      this.changed();
    }
    return played;
  }

  /** Plays audio ahead of the queue once the speaker and the air are free (used by Find). */
  private async playExclusive(wave: Float32Array, label: string) {
    this.radio.paused = true;
    try {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      while (this.radio.onAir) await sleep(50);
      for (let waited = 0; this.link.busy && waited < 4000; waited += 100) await sleep(100);
      return await this.playWave(wave, 'audible', label);
    } finally {
      this.radio.paused = false;
    }
  }

  private logAir(e: Omit<AirEvent, 'id' | 'at'>) {
    this.air = [{ ...e, id: ++this.airSeq, at: Date.now() }, ...this.air].slice(0, 120);
    this.changed();
    return this.airSeq;
  }

  // ---- sending -------------------------------------------------------------------------

  /** Sends what someone wrote, sealed if we are in a circle. Your own check-in's place and family contact become your defaults. */
  async say(draft: Draft, dst?: number) {
    const body = this.stamp(draft);
    await this.transmit(body, { dst });
    if (body.kind === 'checkin' && !body.about) this.update({ place: body.place ?? '', outside: body.outside ?? '' });
  }

  /** Answers a check-in, sealed exactly when it was (`mistake`: the sender takes its own request back): a circle's request is answered inside the circle, an open one in the open. */
  async reply(to: Heard<CheckInBody>, what: ReplyKind, opts: { mistake?: boolean } = {}) {
    const body = { kind: 'reply' as const, ts: nowSec(), nick: this.settings.nick, what, src: to.src, msgId: to.msgId };
    await this.transmit(opts.mistake ? { ...body, mistake: true } : body, { sealed: to.encrypted });
  }

  /** "Send again" for a direct message with no receipt: a fresh packet, sealed as the first was, in place of the old item. */
  async resend(item: FeedItem) {
    if (!item.body) return;
    await this.transmit({ ...item.body, ts: nowSec() }, { dst: item.dst, sealed: item.encrypted });
    // Only once it went: a send refused loses nothing.
    this.journal.drop(item.id);
    this.changed();
  }

  /** Whether something we said is still to go on air: it waits for clear air, or for this device's audio to come back. */
  queued(said: { src: number; msgId: number }) {
    return this.mesh.store.get(storeKey(said))?.queued ?? false;
  }

  /** Whether something we said has been out long enough for its first resend to have come and gone. */
  firstResendPassed(said: { at: number }) {
    return Date.now() - said.at > FIRST_RESEND_MS;
  }

  /** Bytes left in the packet (below 0: over by that many) and seconds on air, for the draft as it would go now. */
  budget(draft: Draft) {
    const n = this.packetBytes(this.stamp(draft));
    return { left: MAX_PAYLOAD - n, seconds: airtimeSec(PROFILES[this.sendProfile], Math.min(MAX_PAYLOAD, n)) };
  }

  /** About how long a file takes to reach a room. Measured with three devices: each chunk costs about 3 × its airtime + 3.9 s. */
  fileSeconds(size: number) {
    const profile = PROFILES[this.sendProfile];
    return chunkFile(0, { name: '', mime: '' }, new Uint8Array(size)).reduce((s, c) => s + 3 * airtimeSec(profile, this.packetBytes(c)) + 3.9, 0);
  }

  private stamp(d: Draft): ContentBody {
    return d.kind === 'contact' ? { ...d, ts: nowSec() } : { ...d, ts: nowSec(), nick: this.settings.nick };
  }

  private packetBytes(body: Body) {
    return HEADER_LEN + encodeBody(body).length + (this.circle || this.settings.passphrase ? SEAL_OVERHEAD : 0);
  }

  /** Sealed for our circle, if we are in one, unless `sealed` is false. */
  private async transmit(body: Body, opts: { dst?: number; sealed?: boolean; ttl?: number } = {}) {
    await this.joining;
    const dst = opts.dst ?? BROADCAST;
    const circle = (opts.sealed ?? true) ? this.circle : null;
    // A circle's thread never goes out in the open.
    if (opts.sealed && !circle) throw new Error(`Join the circle again to ${body.kind === 'reply' ? 'answer' : 'send'} this.`);
    if (opts.sealed === undefined && this.settings.passphrase && !circle) {
      throw new Error('Your circle could not be joined in this browser, so this would go out unsealed. Open Resonance from its https:// address.');
    }
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
    else if (isContent(body) || body.kind === 'reply') this.journal.add(met(p), body);
    this.changed();
    return p;
  }

  async sendFile(name: string, mime: string, data: Uint8Array) {
    await this.joining;
    const { key, chunks } = this.files.create(randomU32() & 0xffff, { name, mime }, data);
    this.journal.file({ src: this.id, msgId: 0, at: Date.now(), hops: 0, encrypted: !!this.circle, dst: BROADCAST }, key);
    for (const c of chunks) await this.transmit(c);
    return key;
  }

  /** Asks the mesh for the chunks of a file we are still missing. */
  requestMissing(key: string) {
    const req = this.files.request(key);
    if (req) return this.ask(req);
  }

  private ask(req: FileRequest) {
    return this.transmit(req, { sealed: false, ttl: FILE_REQUEST_TTL });
  }

  // ---- receiving -------------------------------------------------------------------------

  private async onDeliver(p: Packet) {
    const frame = this.frameInFlight;
    const live = this.frameLive;
    const meta = met(p);
    let plain: Uint8Array | null = p.body;
    if (p.encrypted) plain = this.circle ? await open(this.circle, p) : null;
    if (!plain) {
      if (showsLocked(p.type)) this.journal.add(meta, 'locked');
      return this.changed();
    }
    const body = decodeBody(p.type, plain);
    if (!body) return;
    if (body.kind === 'filereq') {
      // Anyone holding a requested chunk may answer; the mesh lets the holder nearest the asker go first.
      for (const msgId of this.files.asked(body)) this.mesh.answer(body.fileSrc, msgId, p.hops);
    } else if (body.kind === 'range') {
      void this.ranger.onPacket(p, body, frame);
    } else {
      this.record(meta, p, body, frame?.airtimeSec);
      // An answer to our own request goes to everyone, so the one who gave it cannot tell it reached us: say so.
      if (body.kind === 'reply' && body.src === this.id && p.src !== this.id && live) this.acknowledgeReply(p);
    }
    this.changed();
  }

  /** Says we have the answer, and says it once more a little later: the first may be lost in the noise, and the one who answered cannot ask again. */
  private acknowledgeReply(p: Packet) {
    this.mesh.acknowledge(p);
    setTimeout(() => this.mesh.acknowledge(p), ACK_AGAIN_MS * (1 + Math.random()));
  }

  private record(meta: Meta, p: Packet, body: Body, airtimeSec = 0) {
    if (body.kind === 'file') {
      this.journal.file(meta, this.files.heard(p.src, body, p.msgId, airtimeSec).key);
    } else if (isContent(body) || body.kind === 'reply') {
      this.journal.add(meta, body);
      // Name a neighbour in People and the To menu now, not at its next hello minutes from now.
      const n = this.mesh.neighbors.get(p.src);
      if (n && body.kind !== 'contact' && body.nick) n.nick = body.nick;
    }
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
    frames.forEach((f) => this.onFrame(f, false));
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
    const deriving = passphrase ? deriveCircle(passphrase) : null;
    this.joining = Promise.resolve(deriving).catch(() => undefined);
    const circle = await deriving;
    this.settings.passphrase = passphrase;
    this.circle = circle;
    this.changed();
    if (!circle) return;
    for (const item of this.journal.feed.filter((i) => i.locked)) await this.openHeld(circle, item.id, item);
    // File chunks make no locked item, and safety news outlives its own: the store keeps it for days.
    for (const [k, s] of this.mesh.store) if (!showsLocked(peekType(s.bytes)) || isLasting(s.bytes)) await this.openHeld(circle, k);
    this.changed();
  }

  /**
   * Opens a sealed packet in the store with a circle just joined; `meta` is its locked item's, if the
   * feed still has one. Safety news the feed no longer shows goes to the safety log alone.
   */
  private async openHeld(circle: Circle, key: string, meta?: Meta) {
    const stored = this.mesh.store.get(key);
    const p = stored && decodePacket(stored.bytes);
    const plain = p?.encrypted && (await open(circle, p));
    const body = p && plain && decodeBody(p.type, plain);
    if (!body) return;
    const arrived = meta ?? { ...met(p), at: stored.firstHeard, hops: stored.hops };
    if (meta || body.kind === 'file') this.record(arrived, p, body);
    else if (isContent(body) || body.kind === 'reply') this.journal.addToLog(arrived, body);
  }

  private scheduleSave() {
    if (this.saveTimer || !this.saved.available) return;
    this.saveTimer = setTimeout(() => this.flushSave(), 800);
  }

  private flushSave() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  save() {
    this.saved.save({
      identity: { id: this.id },
      settings: this.settings,
      ...this.journal.snapshot(),
      store: saveStore(this.mesh.store.values()),
      ...this.files.snapshot(),
    });
  }

  private restore() {
    const saved = this.saved;
    const resent = this.mesh.hydrate(loadStore(saved.load('store') ?? []));
    this.journal.restore({ safety: saved.load('safety'), feed: saved.load('feed'), resent });
    this.files.restore({ files: saved.load('files') ?? [], chunks: saved.load('chunks') ?? [] });
  }

  /** Forgets everything heard (keeps identity and settings). */
  wipe() {
    this.journal.clear();
    this.air = [];
    this.files.clear();
    this.mesh.store.clear();
    this.changed();
  }
}


/** How a packet met this device, just now. */
/** A sealed packet we cannot open makes a locked item, except a file chunk: one item each would bury the feed. */
const showsLocked = (type: PacketType | null) => type !== PacketType.FileChunk;
const met = (p: Packet): Meta => ({ src: p.src, msgId: p.msgId, at: Date.now(), hops: p.hops, encrypted: p.encrypted, dst: p.dst });

