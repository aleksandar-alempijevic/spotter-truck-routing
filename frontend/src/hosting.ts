import { useEffect, useState } from 'react';

/**
 * Build-time: this build runs on a host that sleeps when idle. `VITE_HOST_SLEEPS` unset, empty or
 * anything but `1`/`true` means it does not, so local dev, tests and the stand-in show no wake copy.
 */
export function hostSleeps(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** Said after a wait has run long, only on a host that sleeps; "may", because it is not known. */
export const WAKE_NOTICE =
  'The server may be waking up after being idle. That can take up to a minute.';

/**
 * The wake copy for a wait: the notice once `waiting` has been true for `afterMs` on a host that
 * sleeps, otherwise null. It resets as soon as the wait stops. The flag, the timer and the copy
 * all live here.
 */
export function useWakeNotice(waiting: boolean, afterMs: number): string | null {
  const active = waiting && hostSleeps(import.meta.env.VITE_HOST_SLEEPS);
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setLong(true), afterMs);
    return () => {
      clearTimeout(timer);
      setLong(false);
    };
  }, [active, afterMs]);
  return active && long ? WAKE_NOTICE : null;
}
