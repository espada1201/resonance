import { type Status, fitUtf8 } from '../mesh/payloads';

/** Keeps a text input within `max` UTF-8 bytes (an emoji is 4), the room its field has on air. */
export function fitInput(e: Event, max: number): string {
  const el = e.target as HTMLInputElement;
  const v = fitUtf8(el.value, max);
  if (v !== el.value) el.value = v;
  return v;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function seconds(s: number): string {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

export const bytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export const STATUS_TEXT: Record<Status, string> = {
  safe: 'Safe',
  help: 'Needs help',
  medical: 'Medical',
  sheltering: 'Sheltering',
};
