import { useEffect, useState, type RefObject } from 'react';

interface Size {
  width: number;
  height: number;
}

/** The element's size in px, kept current by a ResizeObserver; zero while it is not rendered. Frozen: not updated. */
export function useSize(
  ref: RefObject<HTMLElement | null>,
  present: boolean,
  frozen = false,
): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    // While frozen the last size stands, so a drag does not re-fit the map on every frame.
    if (frozen) return;
    if (!present || !element) {
      setSize((old) => (old.width === 0 && old.height === 0 ? old : { width: 0, height: 0 }));
      return;
    }
    const read = () => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, present, frozen]);
  return size;
}
