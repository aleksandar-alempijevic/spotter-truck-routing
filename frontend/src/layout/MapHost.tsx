import { Box } from '@mui/material';
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

export type MapStatus = 'loading' | 'ready' | 'failed' | 'no-basemap';

/** The map, loaded after the form has rendered. The panels stay usable whatever happens here. */
export function MapHost({
  onStatus,
  ...props
}: Omit<MapViewProps, 'onReady' | 'onFailed' | 'onBasemapUnavailable'> & {
  /** Told when the map loads or cannot; the page decides what to say about it. */
  onStatus(status: MapStatus): void;
}) {
  const [wanted, setWanted] = useState(false);
  const [status, setStatus] = useState<MapStatus>('loading');
  useEffect(() => onStatus(status), [status, onStatus]);

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
    </>
  );
}
