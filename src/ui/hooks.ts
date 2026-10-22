import { useEffect, useState } from 'preact/hooks';
import type { Station } from '../station';

/** Re-renders whenever the station changes. */
export function useStation(station: Station) {
  const [, bump] = useState(0);
  useEffect(() => station.subscribe(() => bump((n) => n + 1)), [station]);
}

/** Re-renders on an interval so relative times stay fresh. */
export function useTicker(ms: number) {
  const [, bump] = useState(0);
  useEffect(() => {
    const t = setInterval(() => bump((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Keyboard for a tablist or radiogroup: arrows, Home and End move the choice and the focus
 * (ARIA "roving tabindex": only the chosen option sits in the Tab order).
 */
export function rovingKeys<T>(options: T[], current: T, choose: (o: T) => void) {
  return (e: KeyboardEvent) => {
    const i = options.indexOf(current);
    const n = options.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key in STEP ? (i + STEP[e.key] + n) % n : -1;
    if (next < 0) return;
    e.preventDefault();
    choose(options[next]);
    (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')[next]?.focus();
  };
}

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}
