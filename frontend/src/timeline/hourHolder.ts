import { useSyncExternalStore } from 'react';

/**
 * The hour the slider shows. It lives outside React's page state so that moving the slider
 * renders nothing but the slider's own label: the map subscribes and applies the change itself.
 */
export interface HourHolder {
  get(): number;
  set(hour: number): void;
  subscribe(listener: (hour: number) => void): () => void;
}

export function createHourHolder(initial = 0): HourHolder {
  let hour = initial;
  const listeners = new Set<(hour: number) => void>();
  return {
    get: () => hour,
    set(next) {
      if (next === hour) return;
      hour = next;
      listeners.forEach((listener) => listener(hour));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function useHour(holder: HourHolder): number {
  return useSyncExternalStore(
    (onChange) => holder.subscribe(onChange),
    () => holder.get(),
  );
}
