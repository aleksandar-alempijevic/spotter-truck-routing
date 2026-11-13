import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { RouteView } from '../plan/view';
import { RISK_STYLE, type RiskKey } from '../risk/levels';
import { diffHours, hourInstant, type GridModel } from '../timeline/grid';
import { trucksAt } from '../timeline/trucks';
import type { HourHolder } from '../timeline/hourHolder';
import { BASEMAP_STYLE_URL, PLAIN_STYLE } from './basemap';
import {
  checkpointPoints,
  emptyCollection,
  endpointPoints,
  gridCells,
  routeBounds,
  routeLines,
  selectedPoint,
  truckPoints,
} from './features';
import { glyphImage, hatchImage, ICON_PIXEL_RATIO } from './icons';
import {
  checkpointIconSize,
  checkpointSortKey,
  gridFillColor,
  gridNoForecastOpacity,
  HATCH_IMAGE,
  ICON_PREFIX,
  LAYER,
  routeColor,
  routeWidth,
  SOURCE,
  truckRadius,
} from './layers';
import type { CheckpointRef } from '../plan/view';
import type { MapInsets } from './types';

// Vite emits the worker as its own file; MapLibre cannot find it next to its module otherwise.
maplibregl.setWorkerUrl(workerUrl);

export interface MapEvents {
  onReady(): void;
  onSelectRoute(routeId: string): void;
  onSelectCheckpoint(ref: CheckpointRef): void;
  onBasemapUnavailable(): void;
}

type GeoJsonSource = maplibregl.GeoJSONSource;
const OUR_SOURCES: string[] = Object.values(SOURCE);
const TAP_SLOP_PX = 14;

/**
 * The one map instance. It owns every call into MapLibre; React only hands it data. The slider
 * reaches it through the hour holder, never through React state.
 */
export class MapController {
  private readonly map: maplibregl.Map;
  private readonly resizeObserver: ResizeObserver;
  private styleReady = false;
  private announcedReady = false;
  private fellBack = false;
  private basemapNoticed = false;
  private userMoved = false;

  private routes: readonly RouteView[] = [];
  private selectedRouteId: string | null = null;
  private selectedCheckpoint: CheckpointRef | null = null;
  private grid: GridModel | null = null;
  private hour: HourHolder | null = null;
  private unsubscribeHour: (() => void) | null = null;
  private shownHour = 0;
  private insets: MapInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  constructor(
    private readonly container: HTMLElement,
    private readonly events: MapEvents,
  ) {
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE_URL,
      bounds: [
        [-125, 24],
        [-66, 50],
      ],
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      fadeDuration: 0,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    this.map.on('style.load', () => this.installStyle());
    this.map.on('error', (event) => this.onError(event));
    this.map.on('click', (event) => this.onClick(event.point));
    this.map.on('mousemove', (event) => {
      this.map.getCanvas().style.cursor = this.hit(event.point, [
        LAYER.checkpoints,
        LAYER.routeLine,
      ])
        ? 'pointer'
        : '';
    });
    const moved = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) this.userMoved = true;
    };
    this.map.on('dragstart', moved);
    this.map.on('zoomstart', moved);

    this.resizeObserver = new ResizeObserver(() => {
      this.map.resize();
      if (!this.userMoved) this.fit(false);
    });
    this.resizeObserver.observe(container);
  }

  // ---------- inputs from React ----------

  setRoutes(routes: readonly RouteView[]): void {
    this.routes = routes;
    if (this.styleReady) this.pushRoutes();
  }

  setSelection(routeId: string | null, checkpoint: CheckpointRef | null): void {
    this.selectedRouteId = routeId;
    this.selectedCheckpoint = checkpoint;
    if (this.styleReady) {
      this.pushSelection();
      this.pushRoutes();
    }
  }

  setGrid(model: GridModel | null, hour: HourHolder): void {
    this.unsubscribeHour?.();
    this.unsubscribeHour = null;
    this.grid = model;
    this.hour = hour;
    this.shownHour = hour.get();
    if (this.styleReady) this.pushGrid();
    if (model) this.unsubscribeHour = hour.subscribe((h) => this.showHour(h));
  }

  setInsets(insets: MapInsets): void {
    const changed = (Object.keys(insets) as (keyof MapInsets)[]).some(
      (k) => insets[k] !== this.insets[k],
    );
    this.insets = insets;
    // Until the driver moves the map, the routes stay centred in the part the panels leave open.
    if (changed && !this.userMoved && this.styleReady) this.fit(true);
  }

  /** Fit every route into the part of the map the panels leave visible. */
  fit(animate: boolean): void {
    const bounds = routeBounds(this.routes);
    if (!bounds) return;
    const { clientWidth: width, clientHeight: height } = this.container;
    if (width === 0 || height === 0) return;
    const margin = 24;
    // The credit sits in the bottom-right corner, so keep the routes clear of it.
    const creditRoom = 28;
    const want = {
      top: this.insets.top + margin,
      right: this.insets.right + margin,
      bottom: this.insets.bottom + margin + creditRoom,
      left: this.insets.left + margin,
    };
    // Never let the padding eat the whole canvas, or MapLibre refuses to fit.
    const scaleX = Math.min(1, (width * 0.7) / (want.left + want.right));
    const scaleY = Math.min(1, (height * 0.7) / (want.top + want.bottom));
    this.map.fitBounds(bounds, {
      padding: {
        top: want.top * scaleY,
        bottom: want.bottom * scaleY,
        left: want.left * scaleX,
        right: want.right * scaleX,
      },
      maxZoom: 12,
      duration: animate ? 500 : 0,
    });
  }

  refit(): void {
    this.userMoved = false;
    this.fit(true);
  }

  zoomBy(delta: number): void {
    this.map.zoomTo(this.map.getZoom() + delta, { duration: 250 });
  }

  destroy(): void {
    this.unsubscribeHour?.();
    this.resizeObserver.disconnect();
    this.map.remove();
  }

  // ---------- style and data ----------

  private installStyle(): void {
    const map = this.map;
    for (const key of Object.keys(RISK_STYLE) as RiskKey[]) {
      if (!map.hasImage(ICON_PREFIX + key)) {
        map.addImage(ICON_PREFIX + key, glyphImage(key), { pixelRatio: ICON_PIXEL_RATIO });
      }
    }
    if (!map.hasImage(HATCH_IMAGE)) map.addImage(HATCH_IMAGE, hatchImage());

    for (const id of OUR_SOURCES) {
      if (!map.getSource(id))
        map.addSource(id, { type: 'geojson', data: emptyCollection() as never });
    }

    // The heatmap sits under the basemap's labels; everything else sits on top.
    const firstLabel = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
    const add = (spec: maplibregl.LayerSpecification, before?: string) => {
      if (!map.getLayer(spec.id)) map.addLayer(spec, before);
    };
    add(
      {
        id: LAYER.gridFill,
        type: 'fill',
        source: SOURCE.grid,
        paint: { 'fill-color': 'rgba(0,0,0,0)' },
      },
      firstLabel,
    );
    add(
      {
        id: LAYER.gridNoForecast,
        type: 'fill',
        source: SOURCE.grid,
        paint: { 'fill-pattern': HATCH_IMAGE, 'fill-opacity': gridNoForecastOpacity },
      },
      firstLabel,
    );
    add({
      id: LAYER.routeCasing,
      type: 'line',
      source: SOURCE.routes,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 7 },
    });
    add({
      id: LAYER.routeLine,
      type: 'line',
      source: SOURCE.routes,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#5f7a91', 'line-width': 4 },
    });
    add({
      id: LAYER.checkpoints,
      type: 'symbol',
      source: SOURCE.checkpoints,
      layout: {
        'icon-image': ['concat', ICON_PREFIX, ['get', 'icon']],
        'icon-size': 0.5,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
    add({
      id: LAYER.selectedRing,
      type: 'circle',
      source: SOURCE.selected,
      paint: {
        'circle-radius': 17,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#0d47a1',
        'circle-stroke-width': 3.5,
      },
    });
    add({
      id: LAYER.trucks,
      type: 'circle',
      source: SOURCE.trucks,
      paint: {
        'circle-radius': 9,
        'circle-color': '#212121',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    });
    add({
      id: LAYER.endpoints,
      type: 'circle',
      source: SOURCE.endpoints,
      paint: {
        'circle-radius': 8,
        'circle-color': ['match', ['get', 'kind'], 'origin', '#1b5e20', '#0d47a1'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    });

    this.styleReady = true;
    this.pushRoutes();
    this.pushSelection();
    this.pushGrid();
    if (!this.announcedReady) {
      this.announcedReady = true;
      this.events.onReady();
    }
  }

  private source(id: string): GeoJsonSource | undefined {
    return this.map.getSource(id) as GeoJsonSource | undefined;
  }

  private pushRoutes(): void {
    const map = this.map;
    this.source(SOURCE.routes)?.setData(routeLines(this.routes) as never);
    this.source(SOURCE.checkpoints)?.setData(checkpointPoints(this.routes) as never);
    this.source(SOURCE.endpoints)?.setData(endpointPoints(this.routes) as never);
    const id = this.selectedRouteId;
    map.setPaintProperty(LAYER.routeLine, 'line-color', routeColor(id));
    map.setPaintProperty(LAYER.routeLine, 'line-width', routeWidth(id, 6, 4));
    map.setPaintProperty(LAYER.routeCasing, 'line-width', routeWidth(id, 10, 7));
    map.setLayoutProperty(LAYER.checkpoints, 'icon-size', checkpointIconSize(id));
    map.setLayoutProperty(LAYER.checkpoints, 'symbol-sort-key', checkpointSortKey(id));
    map.setPaintProperty(LAYER.trucks, 'circle-radius', truckRadius(id));
    this.pushTrucks();
  }

  private pushSelection(): void {
    const sel = this.selectedCheckpoint;
    this.source(SOURCE.selected)?.setData(
      selectedPoint(this.routes, sel?.routeId ?? null, sel?.index ?? null) as never,
    );
  }

  private pushGrid(): void {
    const source = this.source(SOURCE.grid);
    if (!source) return;
    // New cells start clean: state left from an earlier grid must not colour them.
    this.map.removeFeatureState({ source: SOURCE.grid });
    if (!this.grid) {
      source.setData(emptyCollection() as never);
      return;
    }
    this.shownHour = this.hour?.get() ?? 0;
    this.pushTrucks();
    this.map.setPaintProperty(LAYER.gridFill, 'fill-color', gridFillColor(this.grid.levelNames));
    source.setData(gridCells(this.grid, this.shownHour) as never);
  }

  /** The slider's path: only the cells whose level differs from the hour on screen are touched. */
  private showHour(hour: number): void {
    const grid = this.grid;
    if (!grid || !this.styleReady) return;
    for (const { cell, level } of diffHours(grid, this.shownHour, hour)) {
      this.map.setFeatureState({ source: SOURCE.grid, id: cell }, { level });
    }
    this.shownHour = hour;
    this.pushTrucks();
  }

  /** The truck on each route at the hour on screen: a few points, set directly, no React. */
  private pushTrucks(): void {
    const source = this.source(SOURCE.trucks);
    if (!source) return;
    const grid = this.grid;
    const trucks = grid ? trucksAt(this.routes, hourInstant(grid, this.shownHour)) : [];
    source.setData(truckPoints(trucks) as never);
  }

  // ---------- events ----------

  private hit(point: maplibregl.PointLike, layers: string[]) {
    if (!this.styleReady) return [];
    const { x, y } = maplibregl.Point.convert(point);
    return this.map.queryRenderedFeatures(
      [
        [x - TAP_SLOP_PX, y - TAP_SLOP_PX],
        [x + TAP_SLOP_PX, y + TAP_SLOP_PX],
      ],
      { layers },
    );
  }

  private onClick(point: maplibregl.Point): void {
    const checkpoint = this.hit(point, [LAYER.checkpoints])[0];
    if (checkpoint) {
      const { routeId, index } = checkpoint.properties as { routeId: string; index: number };
      this.events.onSelectCheckpoint({ routeId, index });
      return;
    }
    const line = this.hit(point, [LAYER.routeLine])[0];
    if (line) this.events.onSelectRoute((line.properties as { id: string }).id);
  }

  private onError(event: object): void {
    const { sourceId } = event as { sourceId?: string };
    if (!this.styleReady && !this.fellBack) {
      // The basemap style did not load: draw the plan on a plain background instead.
      this.fellBack = true;
      this.map.setStyle(PLAIN_STYLE);
      this.noticeBasemap();
    } else if (this.styleReady && sourceId && !OUR_SOURCES.includes(sourceId)) {
      this.noticeBasemap();
    }
  }

  private noticeBasemap(): void {
    if (this.basemapNoticed) return;
    this.basemapNoticed = true;
    this.events.onBasemapUnavailable();
  }
}
