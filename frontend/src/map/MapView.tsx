import { Box, Button, Paper } from '@mui/material';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, type CSSProperties } from 'react';
import type { RouteView } from '../plan/view';
import type { GridModel } from '../timeline/grid';
import type { HourHolder } from '../timeline/hourHolder';
import { MapController } from './controller';
import type { CheckpointRef } from '../plan/view';
import type { RiskKey } from '../risk/levels';
import type { CheckpointPopup, MapInsets } from './types';

export interface MapViewProps {
  routes: readonly RouteView[];
  selectedRouteId: string | null;
  selectedCheckpoint: CheckpointRef | null;
  grid: GridModel | null;
  hour: HourHolder;
  insets: MapInsets;
  /** Changes with every submission: the map fits the new routes once per value. */
  fitKey: number;
  onSelectRoute(routeId: string): void;
  onSelectCheckpoint(ref: CheckpointRef): void;
  /** What the hover popup says about a checkpoint. */
  describeCheckpoint(ref: CheckpointRef): CheckpointPopup | null;
  /** What the readout says about a heatmap cell at the slider's hour. */
  describeCell(level: RiskKey, hour: number): CheckpointPopup | null;
  /** Screen rectangles that lie over the map and that a readout must keep clear of. */
  coveredRects(): readonly DOMRect[];
  onReady(): void;
  /** The map could not be built, or its chunk or render failed: it will not come back. */
  onFailed(): void;
  /** The WebGL context was lost, and may come back. */
  onContextLost(): void;
  onRecovered(): void;
  onBasemapUnavailable(): void;
}

const CONTROL_SX = {
  minWidth: 44,
  minHeight: 44,
  fontSize: 20,
  lineHeight: 1,
  color: 'text.primary',
} as const;

/** The map for the life of the page. Loaded through one dynamic import from `layout/`. */
export default function MapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MapController | null>(null);
  const fittedFor = useRef<number | null>(null);
  const latest = useRef(props);

  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    let controller: MapController;
    try {
      controller = new MapController(containerRef.current!, {
        onReady: () => latest.current.onReady(),
        onSelectRoute: (id) => latest.current.onSelectRoute(id),
        onSelectCheckpoint: (ref) => latest.current.onSelectCheckpoint(ref),
        onBasemapUnavailable: () => latest.current.onBasemapUnavailable(),
        onContextLost: () => latest.current.onContextLost(),
        onRecovered: () => latest.current.onRecovered(),
        describeCheckpoint: (ref) => latest.current.describeCheckpoint(ref),
        describeCell: (level, hour) => latest.current.describeCell(level, hour),
        // The page's panels over the map, and the map's own controls. The credit is the
        // controller's to weigh: a popup may run over it when it must, and not over a control.
        coveredRects: () => [
          ...latest.current.coveredRects(),
          ...(controlsRef.current ? [controlsRef.current.getBoundingClientRect()] : []),
        ],
      });
    } catch {
      latest.current.onFailed();
      return;
    }
    controllerRef.current = controller;
    fittedFor.current = null;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  const { routes, selectedRouteId, selectedCheckpoint, grid, hour, insets, fitKey } = props;
  const { top, right, bottom, left } = insets;

  useEffect(() => {
    controllerRef.current?.setInsets({ top, right, bottom, left });
  }, [top, right, bottom, left]);

  useEffect(() => {
    controllerRef.current?.setRoutes(routes);
    if (routes.length > 0 && fittedFor.current !== fitKey) {
      fittedFor.current = fitKey;
      controllerRef.current?.refit();
    }
  }, [routes, fitKey]);

  useEffect(() => {
    controllerRef.current?.setSelection(selectedRouteId, selectedCheckpoint);
  }, [selectedRouteId, selectedCheckpoint]);

  useEffect(() => {
    controllerRef.current?.setGrid(grid, hour);
  }, [grid, hour]);

  return (
    <Box
      style={
        {
          '--inset-top': `${top}px`,
          '--inset-right': `${right}px`,
          '--inset-bottom': `${bottom}px`,
          '--inset-left': `${left}px`,
        } as CSSProperties
      }
      sx={{
        position: 'fixed',
        inset: 0,
        // The popup only reads out; it never takes the pointer from the checkpoint beneath it.
        '& .checkpoint-popup': { pointerEvents: 'none', zIndex: 2 },
        '& .checkpoint-popup .maplibregl-popup-content': {
          padding: '8px 12px',
          fontSize: 14,
          lineHeight: 1.4,
          color: 'text.primary',
        },
        // The cell readout takes taps (it has a close button); the hover popup never does. The
        // button is a 44 px target in the corner, and the words keep clear of it.
        // Over the map's credit, which a tall readout on a short map may have to cross.
        '& .cell-readout': { zIndex: 3 },
        '& .cell-readout .maplibregl-popup-content': {
          padding: '8px 44px 8px 12px',
          minHeight: 44,
          fontSize: 13,
          lineHeight: 1.3,
        },
        '& .cell-readout .maplibregl-popup-close-button': {
          width: 44,
          height: 44,
          fontSize: 22,
        },
        // The map's own credit stays inside the part of the map the panels leave visible.
        '& .maplibregl-ctrl-bottom-right': {
          bottom: 'var(--inset-bottom)',
          right: 'var(--inset-right)',
        },
      }}
    >
      {/* MapLibre's stylesheet makes its container `position: relative`, so the container is sized
          by its parent, not by `inset`. */}
      <Box ref={containerRef} sx={{ width: '100%', height: '100%' }} />
      <Paper
        ref={controlsRef}
        elevation={3}
        sx={{
          position: 'absolute',
          zIndex: 1,
          top: 'calc(var(--inset-top) + 8px)',
          right: 'calc(var(--inset-right) + 8px)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Button
          aria-label="Zoom in"
          sx={CONTROL_SX}
          onClick={() => controllerRef.current?.zoomBy(1)}
        >
          +
        </Button>
        <Button
          aria-label="Zoom out"
          sx={CONTROL_SX}
          onClick={() => controllerRef.current?.zoomBy(-1)}
        >
          −
        </Button>
        <Button
          aria-label="Fit routes"
          sx={{ ...CONTROL_SX, fontSize: 12 }}
          onClick={() => controllerRef.current?.refit()}
        >
          Fit
        </Button>
      </Paper>
    </Box>
  );
}
