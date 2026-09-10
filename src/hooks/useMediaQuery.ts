import { useEffect, useState } from 'react';

/** Tracks a CSS media query's match state reactively. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const listener = () => setMatches(mql.matches);
    listener();
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [query]);

  return matches;
}

export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');
export const useCanHover = () => useMediaQuery('(hover: hover) and (pointer: fine)');
