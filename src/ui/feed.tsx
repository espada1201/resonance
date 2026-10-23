import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { locate, offset } from '../geo';
import { missing, received } from '../mesh/files';
import { BROADCAST, nodeHex } from '../mesh/packet';
import type { Geo } from '../mesh/payloads';
import type { FeedItem } from '../journal';
import { type RosterEntry, writtenAt } from '../roster';
import type { Station } from '../station';
import { NEED_TEXT, REPLY_TEXT, SKILL_TEXT, STATUS_TEXT, TOPIC_TEXT, ago, bytes } from './format';
import { handFocusOn } from './hooks';
import { Check, Cross, Download, FileIcon, Lock, Pin, WaveFile } from './icons';
import { NoticeBoard } from './notices';
import { receipt } from './roster';

export function who(station: Station, src: number, nick?: string) {
  if (src === station.id) return 'You';
  return named(station, src, nick);
}

/** A device's name as everyone else knows it: its nickname, else its id. */
export function named(station: Station, src: number, nick?: string) {
  return nick || (src === station.id ? station.settings.nick : station.mesh.neighbors.get(src)?.nick) || `#${nodeHex(src)}`;
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function vcard(name: string, phone: string, note: string) {
  const esc = (s: string) => s.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\r\n?|\n/g, '\\n');
  // vCard 3.0 requires N as well as FN; the whole name goes in as the given name.
  return new Blob([`BEGIN:VCARD\r\nVERSION:3.0\r\nN:;${esc(name)};;;\r\nFN:${esc(name)}\r\nTEL:${esc(phone)}\r\nNOTE:${esc(note)}\r\nEND:VCARD\r\n`], { type: 'text/vcard' });
}

function Meta({ station, item }: { station: Station; item: FeedItem }) {
  const nick = item.body && 'nick' in item.body ? item.body.nick : undefined;
  return (
    <header class="item-meta">
      <span class={item.mine ? 'who mine' : 'who'}>{who(station, item.src, nick)}</span>
      {item.dst !== BROADCAST && (
        <span class="chip">{item.mine ? `to ${who(station, item.dst)}` : 'direct to you'}</span>
      )}
      {item.encrypted && (
        <span class="chip sealed" title="Sealed with your circle's passphrase">
          <Lock size={12} /> circle
        </span>
      )}
      {!item.mine && <span class="chip">{item.hops === 0 ? 'heard directly' : `${item.hops} hop${item.hops > 1 ? 's' : ''}`}</span>}
      <time dateTime={new Date(writtenAt(item)).toISOString()}>{ago(writtenAt(item))}</time>
    </header>
  );
}

function Delivery({ station, item }: { station: Station; item: FeedItem }) {
  const [err, setErr] = useState('');
  if (station.queued(item)) return <span class="delivery">waiting to go on air…</span>;
  if (item.mine && item.dst === BROADCAST) {
    return item.passedOn ? (
      <span class="delivery ok">
        <Check size={14} /> sent · another phone has it
      </span>
    ) : (
      <span class="delivery">sent · no other phone has passed it on yet</span>
    );
  }
  const state = item.delivery;
  if (!state) return null;
  if (state === 'acked') return <span class="delivery ok"><Check size={14} /> delivered</span>;
  if (state === 'sending') return <span class="delivery">waiting for receipt…</span>;
  return (
    <>
      {state === 'failed' ? (
        <span class="delivery bad">
          <Cross size={14} /> no answer after 3 tries
        </span>
      ) : (
        <span class="delivery">no receipt before the app closed</span>
      )}
      <button type="button" class="ghost small" disabled={station.status !== 'listening'} onClick={() => station.resend(item).catch((e: Error) => setErr(e.message))}>
        Send again
      </button>
      {err && (
        <span class="error small" role="alert">
          {err}
        </span>
      )}
    </>
  );
}

export function saveSound(station: Station, item: FeedItem) {
  const blob = station.exportWav(item);
  if (!blob) throw new Error('This device no longer keeps this packet, so it cannot be saved as sound.');
  download(blob, `resonance-${nodeHex(item.src)}-${item.msgId.toString(16)}.wav`);
}

/** A call for help answered where it was read. */
function OnMyWay({ station, request }: { station: Station; request: RosterEntry }) {
  const [err, setErr] = useState('');
  return (
    <>
      <button
        type="button"
        class="ghost small"
        onClick={(e) => {
          handFocusOn(e.currentTarget);
          station.reply(request.latest, 'coming').catch((x: Error) => setErr(x.message));
        }}
      >
        On my way
      </button>
      {err && (
        <span class="error small" role="alert">
          {err}
        </span>
      )}
    </>
  );
}

function SoundFileButton({ station, item }: { station: Station; item: FeedItem }) {
  const [err, setErr] = useState('');
  return (
    <>
      <button
        type="button"
        class="ghost small"
        title="Save this packet as a sound file. Play it from any speaker near a Resonance device (phone calls and walkie-talkies cut the tones it needs)."
        onClick={() => {
          try {
            saveSound(station, item);
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        <WaveFile size={14} /> Sound file
      </button>
      {err && (
        <span class="error small" role="alert">
          {err}
        </span>
      )}
    </>
  );
}

/**
 * Pictures a browser shows without running anything. Any other file someone sends, a web page or an
 * SVG, stays a plain download: opened from this app's address, it could read the circle passphrase.
 */
const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A picture with more pixels or a longer side is not drawn: a file of a few bytes can ask the browser for a gigabyte. */
const PREVIEW_PIXELS = 1920 * 1080;
const PREVIEW_SIDE = 4096;

/** How the feed shows a received file: drawn, named too large to draw, or (null) only offered as a download. */
export function preview(mime: string, data: Uint8Array): 'picture' | 'too large' | null {
  const size = PICTURES.has(mime) ? pictureSize(data) : null;
  if (!size) return null;
  const [w, h] = size;
  return w * h > PREVIEW_PIXELS || Math.max(w, h) > PREVIEW_SIDE ? 'too large' : 'picture';
}

/** The size a browser decodes a PNG, JPEG, GIF or WebP to, from its header, whatever type the file claims. */
function pictureSize(b: Uint8Array): [number, number] | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const is = (at: number, s: string) => String.fromCharCode(...b.subarray(at, at + s.length)) === s;
  const u24 = (at: number) => v.getUint16(at, true) | (v.getUint8(at + 2) << 16);
  try {
    if (is(0, '\x89PNG\r\n\x1a\n') && is(12, 'IHDR')) return [v.getUint32(16), v.getUint32(20)];
    if (is(0, '\xff\xd8')) return jpegSize(v);
    if (is(0, 'GIF8')) return gifSize(v);
    if (!is(0, 'RIFF')) return null;
    if (is(8, 'WEBPVP8 ')) return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
    if (is(8, 'WEBPVP8L')) return [(v.getUint16(21, true) & 0x3fff) + 1, ((v.getUint32(21, true) >>> 14) & 0x3fff) + 1];
    if (is(8, 'WEBPVP8X')) return [u24(24) + 1, u24(27) + 1];
  } catch {
    return null;
  }
  return null;
}

/** A JPEG's size is in its first frame header: a marker from C0 to CF, but for C4, C8 and CC. */
function jpegSize(v: DataView): [number, number] | null {
  for (let at = 2; v.getUint8(at) === 0xff; ) {
    const marker = v.getUint8(at + 1);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [v.getUint16(at + 7), v.getUint16(at + 5)];
    if (marker === 0xff) at++;
    else if (marker === 0xc4 || marker === 0xcc || marker >= 0xdb) at += 2 + v.getUint16(at + 2);
    else return null;
  }
  return null;
}

/** Browsers grow a GIF to hold its first frame, wherever that frame says it is. */
function gifSize(v: DataView): [number, number] | null {
  const flags = v.getUint8(10);
  let at = 13 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  while (v.getUint8(at) === 0x21) {
    at += 2;
    while (v.getUint8(at)) at += v.getUint8(at) + 1;
    at++;
  }
  if (v.getUint8(at) !== 0x2c) return null;
  const [x, y, w, h] = [1, 3, 5, 7].map((i) => v.getUint16(at + i, true));
  return [Math.max(v.getUint16(6, true), x + w), Math.max(v.getUint16(8, true), y + h)];
}

function FileView({ station, item }: { station: Station; item: FeedItem }) {
  const f = station.files.get(item.fileKey!);
  const data = useMemo(() => (f ? station.files.data(f.key) : null), [f, f && received(f)]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!data || !f?.meta) return;
    const u = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: PICTURES.has(f.meta.mime) ? f.meta.mime : 'application/octet-stream' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data]);
  if (!f) return <p class="muted">This device no longer keeps this file.</p>;
  const got = received(f);
  const name = f.meta?.name ?? 'Incoming file';
  const shown = data && f.meta ? preview(f.meta.mime, data) : null;
  return (
    <div class="file">
      <div class="file-row">
        <FileIcon />
        <div class="file-name">
          <strong>{name}</strong>
          <span class="muted small">
            {f.meta ? bytes(f.meta.size) : 'size unknown'} · {got}/{f.total} pieces
          </span>
        </div>
      </div>
      {!data && (
        <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={f.total} aria-valuenow={got} aria-label={`${name} progress`}>
          <span style={{ width: `${(got / f.total) * 100}%` }} />
        </div>
      )}
      {url && shown === 'picture' && <img class="file-preview" src={url} alt={name} />}
      {shown === 'too large' && <p class="muted small">Too large to preview.</p>}
      <div class="actions">
        {url && (
          <a class="button ghost small" href={url} download={name}>
            <Download size={14} /> Save file
          </a>
        )}
        {!data && !item.mine && (
          <button type="button" class="ghost small" onClick={() => void station.requestMissing(f.key)}>
            Ask for {missing(f).length} missing
          </button>
        )}
      </div>
    </div>
  );
}

/** Where a pin is from here; until we know where we are, its coordinates and a way to find out. */
function PinLine({ station, geo, me }: { station: Station; geo: Geo; me: Geo | null }) {
  const [err, setErr] = useState('');
  const off = me && offset(me, geo);
  return (
    <p class="geo small">
      <Pin size={14} />
      {me ? (off ? `${off} of you` : 'Right next to you') : `${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)}`}
      {` · ±${geo.accuracyM} m`}
      {!me && (
        <button
          type="button"
          class="ghost small"
          onClick={() =>
            locate()
              .then((g) => station.setPosition(g))
              .catch((e: Error) => setErr(e.message))
          }
        >
          Show distance
        </button>
      )}
      {err && <span class="error"> {err}</span>}
    </p>
  );
}

function Item({ station, item, kind, actions, children }: { station: Station; item: FeedItem; kind?: string; actions?: ComponentChildren; children: ComponentChildren }) {
  return (
    <article class={kind ? `item ${kind}` : 'item'}>
      <Meta station={station} item={item} />
      {children}
      {actions && <div class="actions">{actions}</div>}
    </article>
  );
}

interface ItemProps {
  station: Station;
  item: FeedItem;
  position: Geo | null;
  /** The open request this check-in makes, if it is one. */
  request?: RosterEntry;
  onReply?: (src: number) => void;
}

function FeedItemView({ station, item, position, request, onReply }: ItemProps) {
  const shell = { station, item };
  if (item.locked) {
    return (
      <Item {...shell} kind="locked">
        <p class="muted">
          <Lock size={14} /> Sealed for a circle you are not in.
          {station.circleChannel !== null && ' If you should be, check the passphrase in Settings.'}
          {station.settings.relay && ' Your device still relays it.'}
        </p>
      </Item>
    );
  }
  if (item.fileKey) {
    return (
      <Item {...shell}>
        <FileView station={station} item={item} />
      </Item>
    );
  }
  const b = item.body;
  if (!b) return null;
  const sound = <SoundFileButton station={station} item={item} />;
  const delivery = <Delivery station={station} item={item} />;
  if (b.kind === 'checkin') {
    const replies = station.journal.repliesTo(item.src, item.msgId);
    const answerable =
      request && station.status === 'listening' && !(item.mine && !b.about) && !request.replies.some((r) => r.src === station.id && r.body.what === 'coming');
    return (
      <Item
        {...shell}
        kind={`checkin s-${b.status}`}
        actions={
          <>
            {delivery}
            {answerable && <OnMyWay station={station} request={request} />}
            {sound}
          </>
        }
      >
        <p class="status-line">
          <span class="status-word">{STATUS_TEXT[b.status]}</span>
          {b.about && (
            <span>
              <strong>{b.about}</strong>, reported by {item.mine ? 'you' : named(station, item.src, b.nick)}
            </span>
          )}
          {b.place && <span>{b.place}</span>}
          {b.note && <span>{b.note}</span>}
        </p>
        {b.needs && (
          <p class="pills" aria-label="Needs">
            {b.needs.map((n) => (
              <span key={n} class="chip need">
                {NEED_TEXT[n]}
              </span>
            ))}
          </p>
        )}
        {b.geo && <PinLine station={station} geo={b.geo} me={position} />}
        {b.outside && <p class="muted small">For family outside: {b.outside}</p>}
        {replies.map((r) => (
          <p key={`${r.src}:${r.msgId}`} class="small reply">
            {r.src === station.id ? `You ${r.body.what === 'coming' ? 'are on the way' : REPLY_TEXT[r.body.what]}` : `${named(station, r.src, r.body.nick)} ${REPLY_TEXT[r.body.what]}`}
            {' · '}
            {[ago(writtenAt(r)), receipt(station, r)].filter(Boolean).join(' · ')}
          </p>
        ))}
      </Item>
    );
  }
  if (b.kind === 'notice') {
    return (
      <Item
        {...shell}
        kind={`notice t-${b.topic}`}
        actions={
          <>
            {delivery}
            {sound}
          </>
        }
      >
        <span class="topic">{TOPIC_TEXT[b.topic]}</span>
        <p class="notice-text">{b.text}</p>
        <p class="muted small">
          {[b.place, `for ${b.hours < 24 ? `${b.hours} hours` : `${b.hours / 24} day${b.hours > 24 ? 's' : ''}`}`].filter(Boolean).join(' · ')}
        </p>
      </Item>
    );
  }
  if (b.kind === 'contact') {
    return (
      <Item
        {...shell}
        kind="contact"
        actions={
          <>
            {delivery}
            <button type="button" class="ghost small" onClick={() => download(vcard(b.name, b.phone, b.note), `${b.name || 'contact'}.vcf`)}>
              <Download size={14} /> Save contact
            </button>
            {sound}
          </>
        }
      >
        <div class="card">
          <strong>{b.name}</strong>
          {b.phone && <a href={`tel:${b.phone.replace(/[^+\d]/g, '')}`}>{b.phone}</a>}
          {b.skills && <span>Can help with: {b.skills.map((k) => SKILL_TEXT[k].toLowerCase()).join(', ')}</span>}
          {b.note && <span class="muted">{b.note}</span>}
        </div>
      </Item>
    );
  }
  return (
    <Item
      {...shell}
      kind={item.mine ? 'text mine' : 'text'}
      actions={
        <>
          {delivery}
          {!item.mine && onReply && (
            <button type="button" class="ghost small" aria-label={`Reply to ${named(station, item.src, b.nick)}`} onClick={() => onReply(item.src)}>
              Reply
            </button>
          )}
          {sound}
        </>
      }
    >
      <p class="text-body">{b.text}</p>
    </Item>
  );
}

export function Feed({ station, onReply }: { station: Station; onReply?: (src: number) => void }) {
  const notices = <NoticeBoard notices={station.journal.notices()} by={(src, nick) => who(station, src, nick)} />;
  if (!station.journal.feed.length) {
    return (
      <div class="empty">
        {notices}
        <p class="empty-title">No messages yet.</p>
        <p>
          Messages from any device within earshot appear here, including ones that other phones passed on. Say something below
          {station.transport.kind === 'simulated' ? (
            <>
              , or open{' '}
              <a href="?air=sim&at=3,0" target="_blank">
                another tab on simulated air
              </a>{' '}
              to watch two devices talk.
            </>
          ) : (
            '.'
          )}
        </p>
      </div>
    );
  }
  const open = new Map(
    station.journal
      .roster()
      .filter((e) => e.open)
      .map((e) => [`${e.latest.src}:${e.latest.msgId}`, e]),
  );
  return (
    <div class="feed">
      {notices}
      {station.journal.feed.map((item) => (
        <FeedItemView key={item.id} station={station} item={item} position={station.position} request={open.get(item.id)} onReply={onReply} />
      ))}
    </div>
  );
}
