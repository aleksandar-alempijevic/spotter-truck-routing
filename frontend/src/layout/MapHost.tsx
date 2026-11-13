import { Box } from '@mui/material';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { MapViewProps } from '../map/MapView';
import { ErrorBoundary } from './ErrorBoundary';

// The one dynamic import of the map. MapLibre, its worker and its CSS stay in this chunk.
const MapView = lazy(() =>
  import('../map/MapView').catch(() => ({
    default: ({ onFailed }: MapViewProps) => <ReportFailed onFailed={onFailed} />,
  })),
);

/** Tells the page the map has failed, once, and draws nothing. */
function ReportFailed({ onFailed }: { onFailed(): void }) {
  useEffect(() => onFailed(), [onFailed]);
  return null;
}

export type MapStatus = 'loading' | 'ready' | 'failed' | 'no-basemap';

/** The map, loaded after the form has rendered. The panels stay usable whatever happens here. */
export function MapHost({
  onStatus,
  ...props
}: Omit<MapViewProps, 'onReady' | 'onFailed' | 'onRecovered' | 'onBasemapUnavailable'> & {
  /** Told when the map loads or cannot; the page decides what to say about it. */
  onStatus(status: MapStatus): void;
}) {
  const [wanted, setWanted] = useState(false);
  const [status, setStatus] = useState<MapStatus>('loading');
  const failed = useCallback(() => setStatus('failed'), []);
  useEffect(() => onStatus(status), [status, onStatus]);

  useEffect(() => {
    const timer = setTimeout(() => setWanted(true), 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <Box aria-hidden sx={{ position: 'fixed', inset: 0, bgcolor: '#e9eef2' }} />
      {wanted && (
        // A map that throws while rendering is a failed map: the panels stay, and the corner says so.
        <ErrorBoundary fallback={<ReportFailed onFailed={failed} />}>
          <Suspense fallback={null}>
            <MapView
              {...props}
              onReady={() => setStatus((s) => (s === 'loading' ? 'ready' : s))}
              onFailed={failed}
              onRecovered={() => setStatus((s) => (s === 'failed' ? 'ready' : s))}
              onBasemapUnavailable={() => setStatus((s) => (s === 'failed' ? s : 'no-basemap'))}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  );
}
