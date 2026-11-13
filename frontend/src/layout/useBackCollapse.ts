import { useEffect, useRef } from 'react';

const pushEntry = () =>
  window.history.pushState({ ...(window.history.state as object | null), sheet: true }, '');

/**
 * Makes the Back gesture collapse something open before it leaves the page. While `open`, one
 * history entry belongs to it: Back consumes that entry and calls `collapse`, and closing it by
 * another route (a button, a drag) removes the entry again so the history stays as it was.
 *
 * Going back is asynchronous. Reopening before the pop that closing asked for has arrived would
 * push an entry that the pending pop then takes away, so the push waits for that pop.
 */
export function useBackCollapse(open: boolean, collapse: () => void): void {
  const owns = useRef(false);
  // Pops this hook caused itself, whose popstate events must not collapse anything.
  const ownPops = useRef(0);
  // Opened again while an own pop was still on its way: push once it has arrived.
  const pushAfterPop = useRef(false);
  const latest = useRef(collapse);

  useEffect(() => {
    latest.current = collapse;
  });

  useEffect(() => {
    if (open && !owns.current) {
      if (ownPops.current > 0) {
        pushAfterPop.current = true;
      } else {
        pushEntry();
        owns.current = true;
      }
    } else if (!open) {
      pushAfterPop.current = false;
      if (owns.current) {
        owns.current = false;
        ownPops.current += 1;
        window.history.back();
      }
    }
  }, [open]);

  useEffect(() => {
    const onPop = () => {
      if (ownPops.current > 0) {
        ownPops.current -= 1;
        if (ownPops.current === 0 && pushAfterPop.current) {
          pushAfterPop.current = false;
          pushEntry();
          owns.current = true;
        }
        return;
      }
      if (owns.current) {
        owns.current = false;
        latest.current();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
}
