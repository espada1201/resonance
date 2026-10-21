import { useEffect, useMemo, useState } from 'preact/hooks';
import { bearingDeg, compassPoint, distanceM, formatDistance } from '../geo';
import { missing, received } from '../mesh/files';
import { BROADCAST } from '../mesh/packet';
import { type FeedItem, type Station, nodeHex } from '../station';
import { STATUS_TEXT, ago, bytes } from './format';
import { Check, Cross, Download, FileIcon, Lock, Pin, WaveFile } from './icons';

export function who(station: Station, src: number, nick?: string) {
  if (src === station.id) return 'You';
  return nick || station.mesh.neighbors.get(src)?.nick || `#${nodeHex(src)}`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function vcard(name: string, phone: string, note: string) {
  const esc = (s: string) => s.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  return new Blob([`BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${esc(name)}\r\nTEL:${esc(phone)}\r\nNOTE:${esc(note)}\r\nEND:VCARD\r\n`], { type: 'text/vcard' });
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
      <time dateTime={new Date(item.at).toISOString()}>{ago(item.at)}</time>
    </header>
  );
}

function Delivery({ state }: { state: FeedItem['delivery'] }) {
  if (!state) return null;
  if (state === 'acked') return <span class="delivery ok"><Check size={14} /> delivered</span>;
  if (state === 'failed') return <span class="delivery bad"><Cross size={14} /> no answer after 3 tries</span>;
  return <span class="delivery">waiting for receipt…</span>;
}

function SoundFileButton({ station, item }: { station: Station; item: FeedItem }) {
  return (
    <button
      type="button"
      class="ghost small"
      title="Save this packet as a sound file. Play it from any speaker, radio or phone call near a Resonance device."
      onClick={() => {
        const blob = station.exportWav(item);
        if (blob) download(blob, `resonance-${nodeHex(item.src)}-${item.msgId.toString(16)}.wav`);
      }}
    >
      <WaveFile size={14} /> Sound file
    </button>
  );
}

function FileView({ station, item }: { station: Station; item: FeedItem }) {
  const f = station.files.get(item.fileKey!);
  const data = useMemo(() => (f ? station.fileData(f.key) : null), [f, f && received(f)]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!data || !f?.meta) return;
    const u = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: f.meta.mime || 'application/octet-stream' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data]);
  if (!f) return <p class="muted">File details are gone.</p>;
  const got = received(f);
  const name = f.meta?.name ?? 'Incoming file';
  const isImage = f.meta?.mime.startsWith('image/');
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
      {url && isImage && <img class="file-preview" src={url} alt={name} />}
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

export function FeedItemView({ station, item, position }: { station: Station; item: FeedItem; position?: import('../mesh/payloads').Geo | null }) {
  if (item.locked) {
    return (
      <article class="item locked">
        <Meta station={station} item={item} />
        <p class="muted">
          <Lock size={14} /> Sealed for a circle you are not in. Your device still relays it.
        </p>
      </article>
    );
  }
  if (item.fileKey) {
    return (
      <article class="item">
        <Meta station={station} item={item} />
        <FileView station={station} item={item} />
      </article>
    );
  }
  const b = item.body;
  if (!b) return null;
  if (b.kind === 'checkin') {
    const there = b.geo && position ? { d: distanceM(position, b.geo), brg: bearingDeg(position, b.geo) } : null;
    return (
      <article class={`item checkin s-${b.status}`}>
        <Meta station={station} item={item} />
        <p class="status-line">
          <span class="status-word">{STATUS_TEXT[b.status]}</span>
          {b.note && <span>{b.note}</span>}
        </p>
        {b.geo && (
          <p class="geo small">
            <Pin size={14} />
            {there ? `${formatDistance(there.d)} ${compassPoint(there.brg)} of you` : `${b.geo.lat.toFixed(4)}, ${b.geo.lon.toFixed(4)}`} · ±{b.geo.accuracyM} m
          </p>
        )}
        <div class="actions">
          <Delivery state={item.delivery} />
          <SoundFileButton station={station} item={item} />
        </div>
      </article>
    );
  }
  if (b.kind === 'contact') {
    return (
      <article class="item contact">
        <Meta station={station} item={item} />
        <div class="card">
          <strong>{b.name}</strong>
          {b.phone && <a href={`tel:${b.phone.replace(/[^+\d]/g, '')}`}>{b.phone}</a>}
          {b.note && <span class="muted">{b.note}</span>}
        </div>
        <div class="actions">
          <button type="button" class="ghost small" onClick={() => download(vcard(b.name, b.phone, b.note), `${b.name || 'contact'}.vcf`)}>
            <Download size={14} /> Save contact
          </button>
          <SoundFileButton station={station} item={item} />
        </div>
      </article>
    );
  }
  return (
    <article class={item.mine ? 'item text mine' : 'item text'}>
      <Meta station={station} item={item} />
      <p class="text-body">{b.kind === 'text' ? b.text : ''}</p>
      <div class="actions">
        <Delivery state={item.delivery} />
        <SoundFileButton station={station} item={item} />
      </div>
    </article>
  );
}

export function Feed({ station }: { station: Station }) {
  if (!station.feed.length) {
    return (
      <div class="empty">
        <p class="empty-title">The room is quiet.</p>
        <p>
          Messages from any device within earshot land here, including ones that hopped through other phones on the way. Say something below, or open a
          second tab in <a href="?air=sim">simulated air</a> to watch two devices talk.
        </p>
      </div>
    );
  }
  return (
    <div class="feed">
      {station.feed.map((item) => (
        <FeedItemView key={item.id} station={station} item={item} position={station.position} />
      ))}
    </div>
  );
}
