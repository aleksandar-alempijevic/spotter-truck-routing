import { useEffect, useState, type RefObject } from 'react';

export interface Size {
  width: number;
  height: number;
}

/** The element's size in px, kept current by a ResizeObserver; zero while it is not rendered. */
export function useSize(ref: RefObject<HTMLElement | null>, present: boolean): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!present || !element) {
      setSize((old) => (old.width === 0 && old.height === 0 ? old : { width: 0, height: 0 }));
      return;
    }
    const read = () => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, present]);
  return size;
}
