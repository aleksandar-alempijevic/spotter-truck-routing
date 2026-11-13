import { Alert, Box } from '@mui/material';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { MapViewProps } from '../map/MapView';

// The one dynamic import of the map. MapLibre, its worker and its CSS stay in this chunk.
const MapView = lazy(() =>
  import('../map/MapView').catch(() => ({
    default: function MapChunkFailed({ onFailed }: MapViewProps) {
      useEffect(() => onFailed(), [onFailed]);
      return <></>;
    },
  })),
);

type MapStatus = 'loading' | 'ready' | 'failed' | 'no-basemap';

/** The map, loaded after the form has rendered. The panels stay usable whatever happens here. */
export function MapHost(
  props: Omit<MapViewProps, 'onReady' | 'onFailed' | 'onBasemapUnavailable'>,
) {
  const [wanted, setWanted] = useState(false);
  const [status, setStatus] = useState<MapStatus>('loading');

  useEffect(() => {
    const timer = setTimeout(() => setWanted(true), 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <Box aria-hidden sx={{ position: 'fixed', inset: 0, bgcolor: '#e9eef2' }} />
      {wanted && (
        <Suspense fallback={null}>
          <MapView
            {...props}
            onReady={() => setStatus((s) => (s === 'loading' ? 'ready' : s))}
            onFailed={() => setStatus('failed')}
            onBasemapUnavailable={() => setStatus((s) => (s === 'failed' ? s : 'no-basemap'))}
          />
        </Suspense>
      )}
      {(status === 'failed' || status === 'no-basemap') && (
        <Alert
          severity="warning"
          role="status"
          sx={{
            position: 'fixed',
            zIndex: 2,
            left: `calc(${props.insets.left}px + 8px)`,
            top: `calc(${props.insets.top}px + 8px)`,
            right: 64,
            maxWidth: 420,
          }}
        >
          {status === 'failed'
            ? 'The map is not available on this device. Your routes and weather risk are still listed.'
            : 'The map background could not be loaded. Routes and risk are still drawn.'}
        </Alert>
      )}
    </>
  );
}
