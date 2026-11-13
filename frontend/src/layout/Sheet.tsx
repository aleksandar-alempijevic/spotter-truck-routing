import { Box, Button, ButtonBase, Paper } from '@mui/material';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

/** Three heights, changed by buttons, by tapping the handle or by dragging it. No modal. */
export type SheetState = 'peek' | 'half' | 'full';

const ORDER: readonly SheetState[] = ['peek', 'half', 'full'];

/** Movement under this many pixels is a tap, not a drag. */
const DRAG_SLOP_PX = 6;
/** A release faster than this many px/ms moves one step in the direction of the flick. */
const FLICK_PX_PER_MS = 0.6;
const PEEK_FALLBACK_PX = 160;

interface Props {
  state: SheetState;
  onState(state: SheetState): void;
  /** Height of whatever sits above the sheet at full height, such as the trip bar. */
  topClearance: number;
  /** True from the first drag movement to its release: the parent should not re-measure meanwhile. */
  onDragging?(dragging: boolean): void;
  /** What the sheet shows at a height; during a drag it follows the height the finger has reached. */
  children(tier: SheetState): ReactNode;
}

interface Drag {
  pointerId: number;
  startY: number;
  startHeight: number;
  min: number;
  max: number;
  stops: Record<SheetState, number>;
  lastY: number;
  lastAt: number;
  velocity: number;
  moved: boolean;
}

function nearest(stops: Drag['stops'], height: number): SheetState {
  return ORDER.reduce((best, s) =>
    Math.abs(stops[s] - height) < Math.abs(stops[best] - height) ? s : best,
  );
}

/**
 * A nonmodal bottom sheet. The map behind it keeps every gesture because nothing covers it but
 * the sheet itself, and the sheet's only drag target is its handle, which takes the touch
 * (`touch-action: none`) so the page and the map never see it. The height changes by writing the
 * element's style directly while the finger moves; React hears of the result once, on release.
 */
export function Sheet({ state, onState, topClearance, onDragging, children }: Props) {
  const at = ORDER.indexOf(state);
  const paperRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const peekHeight = useRef(PEEK_FALLBACK_PX);
  // Set for the click that ends a drag, so releasing the handle does not also cycle the state.
  const swallowClick = useRef(false);
  const [preview, setPreview] = useState<SheetState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // A new height starts at the top of its content: what was scrolled to at another height is
  // not what the driver comes back to.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [state]);

  // The peek height is whatever its content makes it; the drag needs it as a stop.
  useEffect(() => {
    const paper = paperRef.current;
    if (state !== 'peek' || !paper) return;
    const read = () => {
      // The height a drag sets by hand is not the peek height.
      if (!drag.current?.moved) peekHeight.current = paper.offsetHeight;
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(paper);
    return () => observer.disconnect();
  }, [state]);

  const height = {
    peek: 'auto',
    half: '50dvh',
    full: `calc(100dvh - ${topClearance}px)`,
  }[state];

  const finish = (target: SheetState | null) => {
    const paper = paperRef.current;
    if (paper) {
      paper.style.height = '';
      paper.style.maxHeight = '';
    }
    drag.current = null;
    setPreview(null);
    onDragging?.(false);
    if (target && target !== state) onState(target);
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const paper = paperRef.current;
    if (!paper || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const full = viewport - topClearance;
    // The slider bar sits above the sheet except at full height; the sheet may not push it under
    // the trip bar.
    const barAbove =
      state === 'full' ? 0 : (paper.parentElement?.offsetHeight ?? 0) - paper.offsetHeight;
    const min = Math.min(peekHeight.current, full);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: paper.offsetHeight,
      min,
      max: Math.max(min, full - barAbove),
      stops: { peek: min, half: Math.min(viewport * 0.5, full), full },
      lastY: event.clientY,
      lastAt: event.timeStamp,
      velocity: 0,
      moved: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const paper = paperRef.current;
    if (!d || !paper || event.pointerId !== d.pointerId) return;
    const dy = d.startY - event.clientY;
    if (!d.moved) {
      if (Math.abs(dy) < DRAG_SLOP_PX) return;
      d.moved = true;
      // Committed before the height moves, so the parent has stopped measuring when it does.
      flushSync(() => onDragging?.(true));
    }
    const next = Math.min(d.max, Math.max(d.min, d.startHeight + dy));
    paper.style.maxHeight = 'none';
    paper.style.height = `${next}px`;
    const dt = event.timeStamp - d.lastAt;
    if (dt > 0) d.velocity = (d.lastY - event.clientY) / dt;
    d.lastY = event.clientY;
    d.lastAt = event.timeStamp;
    const reached = nearest(d.stops, next);
    setPreview((old) => (old === reached ? old : reached));
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const paper = paperRef.current;
    if (!d || !paper || event.pointerId !== d.pointerId) return;
    if (!d.moved) {
      drag.current = null;
      return;
    }
    swallowClick.current = true;
    // The click follows the release at once; if none does, the flag must not outlive it.
    setTimeout(() => (swallowClick.current = false), 100);
    const current = paper.offsetHeight;
    let target = nearest(d.stops, current);
    if (Math.abs(d.velocity) > FLICK_PX_PER_MS) {
      const step = d.velocity > 0 ? 1 : -1;
      target = ORDER[Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(state) + step))];
    }
    finish(target);
  };

  const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
    if (drag.current && event.pointerId === drag.current.pointerId) {
      if (drag.current.moved) finish(null);
      else drag.current = null;
    }
  };

  return (
    <Paper
      ref={paperRef}
      elevation={8}
      component="section"
      aria-label="Routes and weather"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height,
        maxHeight: state === 'peek' ? '45dvh' : undefined,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        overflow: 'hidden',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, pl: 1, pr: 0.5 }}>
        <ButtonBase
          aria-label={state === 'full' ? 'Collapse the results' : 'Expand the results'}
          onClick={() => {
            if (swallowClick.current) {
              swallowClick.current = false;
              return;
            }
            onState(ORDER[(at + 1) % ORDER.length]);
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          sx={{ flex: 1, height: 44, touchAction: 'none' }}
        >
          <Box sx={{ width: 40, height: 5, borderRadius: 3, bgcolor: 'action.disabled' }} />
        </ButtonBase>
        <Button
          size="small"
          sx={{ minHeight: 44, minWidth: 64 }}
          disabled={at === 0}
          onClick={() => onState(ORDER[at - 1])}
        >
          Less
        </Button>
        <Button
          size="small"
          sx={{ minHeight: 44, minWidth: 64 }}
          disabled={at === ORDER.length - 1}
          onClick={() => onState(ORDER[at + 1])}
        >
          More
        </Button>
      </Box>
      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          px: 2,
          pb: 'calc(16px + env(safe-area-inset-bottom))',
        }}
      >
        {children(preview ?? state)}
      </Box>
    </Paper>
  );
}
