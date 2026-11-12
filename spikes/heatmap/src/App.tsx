import { useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Map, Source, Layer, type MapRef } from 'react-map-gl/maplibre';
import type { ExpressionSpecification, Map as MlMap } from 'maplibre-gl';
import { buildData, HOURS, RISK_COLORS } from './data';
import { installBenchHooks } from './bench';

const params = new URLSearchParams(location.search);
export type Approach = 'global' | 'global-array' | 'global-lean' | 'paint' | 'feature' | 'feature-diff' | 'layers' | 'rebuild';
const APPROACH = (params.get('approach') ?? 'global') as Approach;
const CELLS = Number(params.get('cells') ?? 500);
// ?worker=default leaves MapLibre to find its worker next to its own module (to show the Vite gotcha).
if (params.get('worker') !== 'default') setWorkerUrl(workerUrl);

const STYLE = params.get('style') ?? 'https://tiles.openfreemap.org/styles/positron';

const colorByRisk = (input: ExpressionSpecification): ExpressionSpecification =>
  ['match', input, 0, RISK_COLORS[0], 1, RISK_COLORS[1], 2, RISK_COLORS[2], 3, RISK_COLORS[3], 4, RISK_COLORS[4], '#000000'];

function fillColorFor(approach: Approach): ExpressionSpecification {
  switch (approach) {
    case 'global':
      // computed property key: "r" + hour
      return colorByRisk(['to-number', ['get', ['concat', 'r', ['to-string', ['global-state', 'hour']]]], 0]);
    case 'global-array':
    case 'global-lean':
      return colorByRisk(['at', ['global-state', 'hour'], ['array', 'number', HOURS, ['get', 'risk']]]);
    case 'paint':
      return colorByRisk(['to-number', ['get', 'r0'], 0]);
    case 'feature':
    case 'feature-diff':
      return colorByRisk(['to-number', ['coalesce', ['feature-state', 'risk'], ['get', 'r']], 0]);
    case 'rebuild':
      return colorByRisk(['to-number', ['get', 'r'], 0]);
    case 'layers':
      return colorByRisk(['to-number', ['get', 'r0'], 0]);
  }
}

export default function App() {
  const data = useMemo(() => buildData(CELLS), []);
  const mapRef = useRef<MapRef>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const hourRef = useRef(0);
  const [loaded, setLoaded] = useState(false);

  // Switching the hour never touches React state: the slider drives the map directly.
  const applyHour = useMemo(() => {
    const lastLayer = { h: 0 };
    let prevHour = 0;
    return (map: MlMap, h: number) => {
      switch (APPROACH) {
        case 'global':
        case 'global-array':
        case 'global-lean':
          map.setGlobalStateProperty('hour', h);
          break;
        case 'paint':
          map.setPaintProperty('cells-fill', 'fill-color', colorByRisk(['to-number', ['get', `r${h}`], 0]));
          break;
        case 'feature': {
          const n = data.cells.features.length;
          for (let i = 0; i < n; i++) map.setFeatureState({ source: 'cells', id: i }, { risk: data.risks[i * HOURS + h] });
          break;
        }
        case 'feature-diff': {
          // Only touch cells whose level differs from the hour currently shown.
          const n = data.cells.features.length;
          for (let i = 0; i < n; i++) {
            const v = data.risks[i * HOURS + h];
            if (v !== data.risks[i * HOURS + prevHour]) map.setFeatureState({ source: 'cells', id: i }, { risk: v });
          }
          break;
        }
        case 'layers':
          map.setLayoutProperty(`cells-h${lastLayer.h}`, 'visibility', 'none');
          map.setLayoutProperty(`cells-h${h}`, 'visibility', 'visible');
          lastLayer.h = h;
          break;
        case 'rebuild': {
          const fc = {
            type: 'FeatureCollection' as const,
            features: data.cells.features.map((f, i) => ({
              type: 'Feature' as const, id: i, geometry: f.geometry, properties: { r: data.risks[i * HOURS + h] },
            })),
          };
          (map.getSource('cells') as maplibregl.GeoJSONSource).setData(fc);
          break;
        }
      }
      prevHour = h;
    };
  }, [data]);

  const setHour = (h: number) => {
    hourRef.current = h;
    if (labelRef.current) labelRef.current.textContent = `+${h} h`;
    const map = mapRef.current?.getMap();
    if (map) applyHour(map, h);
  };

  const onLoad = () => {
    const map = mapRef.current!.getMap();
    if (APPROACH.startsWith('global')) map.setGlobalStateProperty('hour', 0);
    installBenchHooks(map, data, APPROACH, setHour);
    setLoaded(true);
  };

  const cellSource = APPROACH === 'rebuild' ? stripForRebuild(data.cells)
    : APPROACH === 'global-lean' ? leanCells(data.cells) : data.cells;

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Map
        ref={mapRef}
        mapLib={maplibregl}
        initialViewState={{ bounds: [[-119.5, 32.5], [-72.5, 43.5]], fitBoundsOptions: { padding: 20 } }}
        mapStyle={STYLE}
        onLoad={onLoad}
        fadeDuration={params.has('fade') ? Number(params.get('fade')) : undefined}
        style={{ width: '100%', height: '100%' }}
      >
        <Source id="cells" type="geojson" data={cellSource}>
          {APPROACH === 'layers'
            ? Array.from({ length: HOURS }, (_, h) => (
              <Layer key={h} id={`cells-h${h}`} type="fill"
                layout={{ visibility: h === 0 ? 'visible' : 'none' }}
                paint={{ 'fill-color': colorByRisk(['to-number', ['get', `r${h}`], 0]), 'fill-opacity': 0.7 }} />
            ))
            : <Layer id="cells-fill" type="fill" paint={{ 'fill-color': fillColorFor(APPROACH), 'fill-opacity': 0.7 }} />}
        </Source>
        <Source id="routes" type="geojson" data={data.routes}>
          <Layer id="routes-line" type="line" paint={{ 'line-color': '#1f3a93', 'line-width': 3 }} />
        </Source>
        <Source id="checkpoints" type="geojson" data={data.checkpoints}>
          <Layer id="checkpoints-circle" type="circle"
            paint={{ 'circle-radius': 4, 'circle-color': colorByRisk(['get', 'risk']), 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 }} />
        </Source>
      </Map>
      <div style={{ position: 'absolute', left: 16, right: 16, bottom: 24, background: '#fffe', padding: '8px 12px', borderRadius: 8, font: '14px system-ui', display: 'flex', gap: 12, alignItems: 'center' }}>
        <b>{APPROACH}</b> · {data.cells.features.length} cells · {data.checkpoints.features.length} checkpoints
        <input id="hour" type="range" min={0} max={HOURS - 1} step={1} defaultValue={0} disabled={!loaded}
          style={{ flex: 1 }} onInput={(e) => setHour(Number((e.target as HTMLInputElement).value))} />
        <span ref={labelRef}>+0 h</span>
      </div>
    </div>
  );
}

// The recommended data shape: one 49-entry array per cell and nothing else.
function leanCells(fc: ReturnType<typeof buildData>['cells']) {
  return { ...fc, features: fc.features.map((f) => ({ ...f, properties: { risk: f.properties!.risk } })) };
}

// The rebuild baseline starts from cells that carry only the current hour.
function stripForRebuild(fc: ReturnType<typeof buildData>['cells']) {
  return { ...fc, features: fc.features.map((f) => ({ ...f, properties: { r: f.properties!.r } })) };
}
