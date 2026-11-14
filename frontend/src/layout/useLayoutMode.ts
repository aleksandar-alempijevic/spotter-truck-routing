import { useSyncExternalStore } from 'react';

/**
 * `sheet`: a bottom sheet over a full-bleed map. `pane`: a side pane beside the map. `wide`: the
 * pane with a second column, for a screen wide enough to leave the map most of its width anyway.
 */
export type LayoutMode = 'sheet' | 'pane' | 'wide';

// The one place the viewport decides the layout. A phone held upright gets the sheet; everything
// else, a phone on its side included, gets the pane, because a sheet would cover a short screen.
const PHONE_WIDTH_QUERY = '(max-width: 599.95px)';
const SHEET_QUERY = `${PHONE_WIDTH_QUERY} and (min-height: 500px)`;
// Two pane columns are about 760 px; from 1700 px that still leaves the map over half the width.
const WIDE_QUERY = '(min-width: 1700px)';

/**
 * How long after a text field loses focus the layout still treats it as focused: moving from one
 * field to the next blurs before it focuses, and the keyboard is still up in between.
 */
const REFOCUS_GRACE_MS = 300;

const query = (text: string) =>
  typeof window.matchMedia === 'function' ? window.matchMedia(text) : null;

// The inputs a keyboard types into. A slider thumb, a checkbox or a button is not one.
const TEXT_ENTRY = ['text', 'search', 'email', 'tel', 'url', 'password', 'number'];

function textFieldFocused(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_ENTRY.includes(el.type);
}

let focusHeldUntil = 0;
let current: LayoutMode | null = null;
/** The page width the sheet was last chosen at: a keyboard does not change it, a turn does. */
let sheetWidth = 0;

/** For tests: forget the last layout and any held focus. */
export function resetLayoutModeForTest(): void {
  focusHeldUntil = 0;
  current = null;
  sheetWidth = 0;
}

function subscribe(onChange: () => void): () => void {
  const lists = [query(SHEET_QUERY), query(WIDE_QUERY)];
  for (const list of lists) list?.addEventListener('change', onChange);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onFocusIn = () => onChange();
  const onFocusOut = () => {
    focusHeldUntil = Date.now() + REFOCUS_GRACE_MS;
    clearTimeout(timer);
    timer = setTimeout(onChange, REFOCUS_GRACE_MS + 20);
  };
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  return () => {
    for (const list of lists) list?.removeEventListener('change', onChange);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    clearTimeout(timer);
  };
}

function read(): LayoutMode {
  let mode: LayoutMode = 'pane';
  if (query(SHEET_QUERY)?.matches) mode = 'sheet';
  else if (query(WIDE_QUERY)?.matches) mode = 'wide';
  // On a phone the on-screen keyboard shrinks the page below the sheet's minimum height. Changing
  // the layout then would mount the form under another parent: the focused field is destroyed and
  // the keyboard closes (Chrome on iOS). So a sheet stays a sheet, by width alone, while a text
  // field is focused.
  const typing = textFieldFocused() || Date.now() < focusHeldUntil;
  // The hold ends if the width changes: that is a turn of the phone, not a keyboard.
  if (
    current === 'sheet' &&
    mode !== 'sheet' &&
    typing &&
    window.innerWidth === sheetWidth &&
    query(PHONE_WIDTH_QUERY)?.matches
  ) {
    return 'sheet';
  }
  current = mode;
  if (mode === 'sheet') sheetWidth = window.innerWidth;
  return mode;
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, read, () => 'pane');
}
