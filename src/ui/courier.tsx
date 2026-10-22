import { type Parcel, courierLink, courierText } from '../courier';
import { writtenAt } from '../roster';
import { NEED_TEXT, STATUS_TEXT, ago } from './format';
import { Send } from './icons';

const when = (sec: number) => new Date(sec * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

interface CourierProps {
  parcels: Parcel[];
  self: number;
  /** A device's name as others know it (never "You": the family reads it). */
  name: (src: number, nick: string) => string;
  /** Null while a reply cannot be sent (not listening). */
  passed: ((p: Parcel) => void) | null;
}

/**
 * Check-ins that name someone outside. A phone that has signal opens its own text or mail app with
 * the message filled in; "I sent it" then tells everyone, so nobody sends it twice.
 */
export function CourierList({ parcels, self, name, passed }: CourierProps) {
  return (
    <ul class="people courier">
      {parcels.map((p) => {
        const c = p.checkin;
        const from = name(c.src, c.body.nick);
        const whom = c.body.about ?? from;
        const text = courierText(c.body, from, when(c.body.ts), NEED_TEXT);
        const subject = `${whom}: ${STATUS_TEXT[c.body.status]} (via Resonance)`;
        return (
          <li key={`${c.src}:${c.msgId}:${p.address.to}`} class={`s-${c.body.status}`}>
            <p class="status-line">
              <span class="status-word">{STATUS_TEXT[c.body.status]}</span>
              <span class="who">{whom}</span>
              <span class="muted small">
                to {p.address.to} · sent {ago(writtenAt(c))}
              </span>
            </p>
            <p class="muted small courier-text">{text}</p>
            {p.passed ? (
              <p class="small reply">
                {p.passed.src === self ? 'You' : name(p.passed.src, p.passed.body.nick)} passed it on · {ago(writtenAt(p.passed))}
              </p>
            ) : (
              <div class="actions">
                <a class="button ghost small" href={courierLink(p.address, subject, text)}>
                  <Send size={14} /> {p.address.channel === 'sms' ? 'Send as text' : 'Send as email'}
                </a>
                {passed && (
                  <button type="button" class="ghost small" onClick={() => passed(p)}>
                    I sent it
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
