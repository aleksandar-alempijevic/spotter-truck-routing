import { useSyncExternalStore } from 'react';

const subscribe = (onChange: () => void) => {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
};

/** The window's height in px, kept current as it resizes or turns. */
export function useViewportHeight(): number {
  return useSyncExternalStore(
    subscribe,
    () => window.innerHeight,
    () => 0,
  );
}
