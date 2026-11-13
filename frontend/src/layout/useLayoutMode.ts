import { useSyncExternalStore } from 'react';

/** `sheet`: a bottom sheet over a full-bleed map. `pane`: a side pane beside the map. */
export type LayoutMode = 'sheet' | 'pane';

// The one place the viewport decides the layout. A phone held upright gets the sheet; everything
// else, a phone on its side included, gets the pane, because a sheet would cover a short screen.
const SHEET_QUERY = '(max-width: 599.95px) and (min-height: 500px)';

const query = () =>
  typeof window.matchMedia === 'function' ? window.matchMedia(SHEET_QUERY) : null;

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(
    subscribe,
    () => (query()?.matches ? 'sheet' : 'pane'),
    () => 'pane',
  );
}
