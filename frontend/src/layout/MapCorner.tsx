import { Alert, Box } from '@mui/material';
import type { ReactNode, Ref } from 'react';
import type { MapStatus } from './MapHost';

interface Props {
  ref?: Ref<HTMLDivElement>;
  /** Where the corner is, in px from the top and left of the screen: just inside the panels. */
  top: number;
  left: number;
  status: MapStatus;
  /** What stacks under the notice, such as the key. */
  children?: ReactNode;
}

/**
 * The one owner of the map's top-left corner. A notice about the map comes first, and whatever
 * else sits there stacks under it, so two things never share the same spot.
 */
export function MapCorner({ ref, top, left, status, children }: Props) {
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
        maxWidth: 420,
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
        <Alert severity="warning" role="status">
          {notice}
        </Alert>
      )}
      {children}
    </Box>
  );
}
