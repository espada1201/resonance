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
