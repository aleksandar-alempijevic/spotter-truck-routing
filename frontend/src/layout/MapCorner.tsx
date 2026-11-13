import { Alert, Box } from '@mui/material';
import type { ReactNode, Ref } from 'react';
import type { MapStatus } from './MapHost';

interface Props {
  ref?: Ref<HTMLDivElement>;
  /** How far the panels cover each edge of the screen, in px: the corner sits just inside them. */
  top: number;
  right: number;
  bottom: number;
  left: number;
  status: MapStatus;
  /** What stacks under the notice, such as the key. */
  children?: ReactNode;
}

/**
 * The one owner of the map's top-left corner. A notice about the map comes first, and whatever
 * else sits there stacks under it, so two things never share the same spot. It stays in the free
 * part of the map: narrower than the room left of the zoom column, and no taller than the room
 * between the panels and above the map's credit, so what stacks in it scrolls instead of running under them.
 */
export function MapCorner({ ref, top, right, bottom, left, status, children }: Props) {
  const notice =
    status === 'failed'
      ? 'The map is not available on this device. Your routes and weather risk are still listed.'
      : status === 'no-basemap'
        ? 'The map background could not be loaded. Routes and risk are still drawn.'
        : null;
  return (
    <Box
      ref={ref}
      sx={{
        position: 'fixed',
        zIndex: 2,
        top: `calc(${top}px + 8px)`,
        left: `calc(${left}px + 8px)`,
        // 68 px: the corner's own 8 px, then the zoom column (8 px gap, 44 px wide, 8 px gap).
        maxWidth: `min(420px, calc(100vw - ${left}px - ${right}px - 68px))`,
        // 48 px more than the panels leave: the map's credit runs along the bottom, 32 px tall.
        maxHeight: `calc(100dvh - ${top}px - ${bottom}px - 48px)`,
        width: 'fit-content',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1,
        pointerEvents: 'none',
        '& > *': { pointerEvents: 'auto' },
      }}
    >
      {notice && (
        <Alert severity="warning" role="status" sx={{ flexShrink: 0 }}>
          {notice}
        </Alert>
      )}
      {children}
    </Box>
  );
}
