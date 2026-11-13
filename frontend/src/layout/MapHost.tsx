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
}: Omit<
  MapViewProps,
  'onReady' | 'onFailed' | 'onContextLost' | 'onRecovered' | 'onBasemapUnavailable'
> & {
  /** Told when the map loads or cannot; the page decides what to say about it. */
  onStatus(status: MapStatus): void;
}) {
  const [wanted, setWanted] = useState(false);
  // What is known about the map, as separate facts: what the corner says follows from them, so one
  // arriving in any order (a basemap error while the context is lost) is never overwritten.
  const [facts, setFacts] = useState({
    ready: false,
    /** It will not come back: the chunk, the render or the construction failed. */
    broken: false,
    /** The WebGL context is lost, and may come back. */
    lost: false,
    noBasemap: false,
  });
  const status: MapStatus =
    facts.broken || facts.lost
      ? 'failed'
      : facts.noBasemap
        ? 'no-basemap'
        : facts.ready
          ? 'ready'
          : 'loading';
  const failed = useCallback(() => setFacts((f) => ({ ...f, broken: true })), []);
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
              // Only a restore ends a loss: a style can install while the canvas is dead.
              onReady={() => setFacts((f) => ({ ...f, ready: true }))}
              onFailed={failed}
              onContextLost={() => setFacts((f) => ({ ...f, lost: true }))}
              onRecovered={() => setFacts((f) => ({ ...f, lost: false }))}
              onBasemapUnavailable={() => setFacts((f) => ({ ...f, noBasemap: true }))}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  );
}
