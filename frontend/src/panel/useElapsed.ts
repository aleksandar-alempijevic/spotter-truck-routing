import { useEffect, useState } from 'react';

/** Whole seconds since `sinceMs`, ticking once a second. Only the component that calls it renders. */
export function useElapsed(sinceMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - sinceMs) / 1000));
}
