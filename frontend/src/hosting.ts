import { useEffect, useState } from 'react';

/**
 * Build-time: this build runs on a host that sleeps when idle. `VITE_HOST_SLEEPS` unset, empty or
 * anything but `1`/`true` means it does not, so local dev, tests and the stand-in show no wake copy.
 */
export function hostSleeps(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export const HOST_SLEEPS = hostSleeps(import.meta.env.VITE_HOST_SLEEPS);

/** Said after a wait has run long, only on a host that sleeps; "may", because it is not known. */
export const WAKE_NOTICE =
  'The server may be waking up after being idle. That can take up to a minute.';

/** True once `waiting` has been true for `afterMs`; false again as soon as it stops. */
export function useWaitedLong(waiting: boolean, afterMs: number): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setLong(true), afterMs);
    return () => {
      clearTimeout(timer);
      setLong(false);
    };
  }, [waiting, afterMs]);
  return waiting && long;
}
