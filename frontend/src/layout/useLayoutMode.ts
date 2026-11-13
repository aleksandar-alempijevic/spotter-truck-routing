import { useSyncExternalStore } from 'react';

/**
 * `sheet`: a bottom sheet over a full-bleed map. `pane`: a side pane beside the map. `wide`: the
 * pane with a second column, for a screen wide enough to leave the map most of its width anyway.
 */
export type LayoutMode = 'sheet' | 'pane' | 'wide';

// The one place the viewport decides the layout. A phone held upright gets the sheet; everything
// else, a phone on its side included, gets the pane, because a sheet would cover a short screen.
const SHEET_QUERY = '(max-width: 599.95px) and (min-height: 500px)';
// Two pane columns are about 760 px; from 1700 px that still leaves the map over half the width.
const WIDE_QUERY = '(min-width: 1700px)';

const query = (text: string) =>
  typeof window.matchMedia === 'function' ? window.matchMedia(text) : null;

function subscribe(onChange: () => void): () => void {
  const lists = [query(SHEET_QUERY), query(WIDE_QUERY)];
  for (const list of lists) list?.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list?.removeEventListener('change', onChange);
  };
}

function read(): LayoutMode {
  if (query(SHEET_QUERY)?.matches) return 'sheet';
  return query(WIDE_QUERY)?.matches ? 'wide' : 'pane';
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, read, () => 'pane');
}
