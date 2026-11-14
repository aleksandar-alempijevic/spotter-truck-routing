import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { RouteView } from '../plan/view';
import { RISK_STYLE, type RiskKey } from '../risk/levels';
import { diffHours, hourInstant, levelKeyAt, type GridModel } from '../timeline/grid';
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
  stopPoints,
  truckPoints,
} from './features';
import { glyphImage, hatchImage, ICON_PIXEL_RATIO, stopImage } from './icons';
import {
  checkpointIconSize,
  checkpointSortKey,
  gridFillColor,
  gridNoForecastOpacity,
  HATCH_IMAGE,
  ICON_PREFIX,
  LAYER,
  MAP_COLORS,
  ROUTE_WIDTH,
  routeColor,
  routeWidth,
  SOURCE,
  STOP_ICON_PREFIX,
  truckRadius,
} from './layers';
import { labelReadings, type Reading } from '../plan/describe';
import type { CheckpointRef, StopRef } from '../plan/view';
import type { MapInsets, MapSpot } from './types';

// Vite emits the worker as its own file; MapLibre cannot find it next to its module otherwise.
maplibregl.setWorkerUrl(workerUrl);

interface MapEvents {
  onReady(): void;
  /** The map's WebGL context was lost; it may come back. */
  onContextLost(): void;
  /** The context came back and the map, whose style had been installed, drew its data again. */
  onRecovered(): void;
  onSelectRoute(routeId: string): void;
  onSelectCheckpoint(ref: CheckpointRef): void;
  /** A required stop was tapped: the page shows it in the list. */
  onSelectStop(ref: StopRef): void;
  /**
   * Every tap on the map says what it landed on, `null` for nothing readable. Where the page shows
   * the reading itself (see `setReadoutOnMap`) this is all the map does with a tap.
   */
  onSpot(spot: MapSpot | null): void;
  onBasemapUnavailable(): void;
  /** The popup's words for a checkpoint; null when there is nothing to say. */
  describeCheckpoint(ref: CheckpointRef): Reading | null;
  /** The readout's words for a heatmap cell's level at an hour; null when there is nothing to say. */
  describeCell(level: RiskKey, hour: number): Reading | null;
  /** Screen rectangles over the map that a readout must keep clear of, such as the key. */
  coveredRects(): readonly DOMRect[];
}

type GeoJsonSource = maplibregl.GeoJSONSource;
const OUR_SOURCES: string[] = Object.values(SOURCE);
const TAP_SLOP_PX = 14;
const LABEL_HALO = { color: '#ffffff', width: 2, blur: 0.5 } as const;
/** Where a popup sits against its point, best first: above, then below, then to the sides. */
const POPUP_ANCHORS = [
  'bottom',
  'top',
  'bottom-left',
  'bottom-right',
  'top-left',
  'top-right',
  'left',
  'right',
] as const;
type PopupAnchor = (typeof POPUP_ANCHORS)[number];
// A popup on hover is for a mouse or a trackpad. A touch screen reports `hover: none`, and the
// panel's list says all the popup does.
/** Widest first: a popup on a narrow map is tried narrower, and its text wraps. */
/** A popup spilling out of the open part by no more than this (px, for rounding) counts as on the map. */
/** Between a point and the near edge of the popup's box: its offset (up to 16) and its 10 px tip. */
const POPUP_GAP_PX = 28;
const MIN_POPUP_HEIGHT_PX = 96;
const NEARLY_ON_MAP = 2;
const READOUT_WIDTHS = [320, 280, 240, 200, 160] as const;
const HOVER_WIDTHS = [280, 220] as const;
const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

/** The words of a popup as DOM, built with text nodes only. */
function popupWords(words: Reading): HTMLElement {
  const content = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = words.title;
  content.append(title);
  for (const line of words.lines) {
    const row = document.createElement('div');
    row.textContent = line;
    content.append(row);
  }
  return content;
}

/**
 * Puts words in a popup whose box is capped at `maxHeight`. The box itself never scrolls, so the
 * close button, which belongs to it, stays where it is; only the words inside scroll, and a cue
 * at the foot says when there is more below. MapLibre builds the box again on every
 * `setDOMContent`, so the cap is set again each time.
 */
function fillPopup(popup: maplibregl.Popup, words: Reading, maxHeight: number): void {
  const root = document.createElement('div');
  Object.assign(root.style, {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minHeight: '0',
  });
  const scroll = document.createElement('div');
  scroll.className = 'popup-scroll';
  Object.assign(scroll.style, { overflowY: 'auto', minHeight: '0', overscrollBehavior: 'contain' });
  scroll.append(popupWords(words));
  const cue = document.createElement('div');
  cue.className = 'popup-more';
  cue.setAttribute('aria-hidden', 'true');
  cue.textContent = 'More ▾';
  Object.assign(cue.style, {
    display: 'none',
    position: 'absolute',
    left: '0',
    right: '0',
    bottom: '0',
    height: '24px',
    alignItems: 'flex-end',
    justifyContent: 'center',
    pointerEvents: 'none',
    background: 'linear-gradient(to bottom, rgba(255,255,255,0), #fff 70%)',
    fontSize: '12px',
    fontWeight: '700',
    color: '#5f6b76',
  });
  root.append(scroll, cue);
  const showCue = () => {
    const more = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 2;
    cue.style.display = more ? 'flex' : 'none';
  };
  scroll.addEventListener('scroll', showCue);
  popup.setDOMContent(root);
  const content = popup.getElement().querySelector<HTMLElement>('.maplibregl-popup-content');
  if (content) {
    content.style.boxSizing = 'border-box';
    content.style.maxHeight = `${maxHeight}px`;
    content.style.overflowY = 'hidden';
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
  }
  showCue();
}

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
  private popup: maplibregl.Popup | null = null;
  private popupKey: string | null = null;
  /** The latest mouse position not yet looked at: hover is answered once per frame. */
  private hoverPoint: maplibregl.Point | null = null;
  private hoverFrame = 0;
  /** The latest hour the slider asked for, applied once per frame. */
  private pendingHour: number | null = null;
  private hourFrame = 0;
  /** The heatmap cell the driver tapped, and its readout, which follows the slider's hour. */
  private readout: {
    cell: number;
    /** Where it opened, so it can be placed again when the open part of the map changes. */
    at: maplibregl.LngLatLike;
    popup: maplibregl.Popup;
    /** The height its box is capped at, kept for when its words change. */
    maxHeight: number;
    /** The checkpoint the readout was opened from, when it was; its words do not change with the hour. */
    checkpoint: Reading | null;
    /** The checkpoint it was opened from, to hand to the page if the layout changes. */
    ref: CheckpointRef | null;
  } | null = null;
  /** Whether a tapped spot is read in a popup over the map; otherwise the page shows it. */
  private readoutOnMap = true;
  /** The page is showing a spot's reading: the map stays where the driver put it, as under a popup. */
  private spotOpen = false;
  /** Where the spot the page is reading lies, to keep it in the open part of the map. */
  private spotAt: maplibregl.LngLatLike | null = null;
  /** What that spot is, to hand back to a popup if the page turns into a pane. */
  private spotWhat: { cell: number | null; ref: CheckpointRef | null } | null = null;
  /** While WebGL's context is lost nothing can be drawn, so nothing is pushed. */
  private contextLost = false;

  private routes: readonly RouteView[] = [];
  private bounds: ReturnType<typeof routeBounds> = null;
  private queuedFit: { animate: boolean; frame: number } | null = null;
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
    this.map.on('mousemove', (event) => this.onHover(event.point));
    this.map.on('mouseout', () => {
      this.hoverPoint = null;
      this.hidePopup();
    });
    const canvas = this.map.getCanvas();
    canvas.addEventListener('webglcontextlost', () => this.onContextLost());
    canvas.addEventListener('webglcontextrestored', () => this.onContextRestored());
    const moved = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) this.userMoved = true;
    };
    this.map.on('dragstart', moved);
    this.map.on('dragstart', () => this.hidePopup());
    this.map.on('zoomstart', moved);

    this.resizeObserver = new ResizeObserver(() => {
      this.map.resize();
      this.queueFit(false);
      this.placeReadoutAgain();
      this.keepSpotVisible();
    });
    this.resizeObserver.observe(container);
  }

  // ---------- inputs from React ----------

  setRoutes(routes: readonly RouteView[]): void {
    // The same routes again, such as the empty list on a form keystroke: nothing to redo.
    if (routes === this.routes) return;
    this.routes = routes;
    this.hideReadout();
    this.bounds = routeBounds(routes);
    this.hidePopup();
    if (this.live) {
      this.pushRouteData();
      this.pushRouteStyle();
    }
  }

  setSelection(routeId: string | null, checkpoint: CheckpointRef | null): void {
    const routeChanged = routeId !== this.selectedRouteId;
    this.selectedRouteId = routeId;
    this.selectedCheckpoint = checkpoint;
    if (this.live) {
      // The stops follow the selected route, so a tap on a checkpoint of the same route leaves them.
      if (routeChanged) this.pushStops();
      this.pushSelection();
      this.pushRouteStyle();
    }
  }

  setGrid(model: GridModel | null, hour: HourHolder): void {
    this.unsubscribeHour?.();
    this.unsubscribeHour = null;
    this.cancelHourFrame();
    this.hideReadout();
    this.grid = model;
    this.hour = hour;
    this.shownHour = hour.get();
    if (this.live) this.pushGrid();
    if (model) this.unsubscribeHour = hour.subscribe((h) => this.queueHour(h));
  }

  setInsets(insets: MapInsets): void {
    const changed = (Object.keys(insets) as (keyof MapInsets)[]).some(
      (k) => insets[k] !== this.insets[k],
    );
    this.insets = insets;
    // A readout open when the panels change (a chosen checkpoint asks the sheet for room) is
    // placed again in the part that is now open.
    if (changed) this.placeReadoutAgain();
    if (changed) this.keepSpotVisible();
    // Until the driver moves the map, the routes stay centred in the part the panels leave open;
    // but not under a readout being read, which would slide away from the finger.
    if (changed && this.live && !this.readout && !this.spotOpen) this.queueFit(true);
  }

  /** Where a tapped spot is read: in a popup on the map, or by the page, which is told of the tap. */
  setReadoutOnMap(onMap: boolean): void {
    if (onMap === this.readoutOnMap) return;
    this.readoutOnMap = onMap;
    if (onMap) {
      // A sheet that turns into a pane: the reading it held becomes a popup for the same spot.
      const { spotAt: at, spotWhat: what } = this;
      if (at && what?.cell != null && this.live) {
        const words = what.ref ? this.events.describeCheckpoint(what.ref) : null;
        if (!what.ref || words) this.showReadout(what.cell, at, words, what.ref);
      }
      this.spotAt = null;
      this.spotWhat = null;
      return;
    }
    // A popup that is open when the page takes over the reading (a pane turned into a sheet) is
    // handed over, not dropped.
    const open = this.readout;
    this.hideReadout();
    this.spotAt = null;
    this.spotWhat = null;
    if (open) {
      this.spotAt = open.at;
      this.spotWhat = { cell: open.cell, ref: open.ref };
      this.events.onSpot({ cell: open.cell, checkpoint: open.ref });
    }
  }

  /** The page says whether it is showing a spot's reading; the map then holds its position. */
  setSpotOpen(open: boolean): void {
    // Only a reading that was shown and is now closed forgets its spot: one handed over a moment
    // before the page says it is showing it has not been shown yet.
    const closed = this.spotOpen && !open;
    this.spotOpen = open;
    if (closed) {
      this.spotAt = null;
      this.spotWhat = null;
    }
  }

  /**
   * The map holds still under a reading, but the spot itself must stay in the open part: when the
   * panels rise over it, the map is panned just far enough to bring it back.
   */
  private keepSpotVisible(): void {
    if (!this.spotOpen || !this.spotAt || !this.live) return;
    const { clientWidth: width, clientHeight: height } = this.container;
    const margin = 28; // a checkpoint's mark and its ring
    const p = this.map.project(this.spotAt);
    const low = (v: number, edge: number) => Math.min(0, v - edge);
    const high = (v: number, edge: number) => Math.max(0, v - edge);
    const dx = low(p.x, this.insets.left + margin) + high(p.x, width - this.insets.right - margin);
    const dy = low(p.y, this.insets.top + margin) + high(p.y, height - this.insets.bottom - margin);
    if (dx !== 0 || dy !== 0) this.map.panBy([dx, dy], { duration: 250 });
  }

  /** An open readout is placed again in the part of the map that is open now. */
  private placeReadoutAgain(): void {
    if (!this.readout) return;
    const { cell, at, checkpoint, ref } = this.readout;
    this.showReadout(cell, at, checkpoint, ref);
  }

  /**
   * A fit at the next frame, for as long as the driver has not moved the map. A resize and an
   * inset change that arrive together make one fit, animated if either asked for it.
   */
  private queueFit(animate: boolean): void {
    if (this.queuedFit) {
      this.queuedFit.animate ||= animate;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const queued = this.queuedFit;
      this.queuedFit = null;
      // Not under a reading the page holds: the spot is kept in view by a pan instead.
      if (queued && !this.userMoved && !this.spotOpen) {
        this.fit(queued.animate);
        // The fit moved the point the readout hangs from.
        this.placeReadoutAgain();
      }
    });
    this.queuedFit = { animate, frame };
  }

  /** Fit every route into the part of the map the panels leave visible. */
  fit(animate: boolean): void {
    const bounds = this.bounds;
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
    this.cancelQueuedFit();
    this.fit(true);
  }

  zoomBy(delta: number): void {
    this.map.zoomTo(this.map.getZoom() + delta, { duration: 250 });
  }

  private cancelQueuedFit(): void {
    if (this.queuedFit) cancelAnimationFrame(this.queuedFit.frame);
    this.queuedFit = null;
  }

  destroy(): void {
    this.cancelQueuedFit();
    this.cancelHourFrame();
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0;
    this.hideReadout();
    this.hidePopup();
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
    for (const key of Object.keys(RISK_STYLE) as RiskKey[]) {
      if (!map.hasImage(STOP_ICON_PREFIX + key)) {
        map.addImage(STOP_ICON_PREFIX + key, stopImage(key), { pixelRatio: ICON_PIXEL_RATIO });
      }
    }

    for (const id of OUR_SOURCES) {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: emptyCollection() });
    }

    // The heatmap sits under the basemap's labels; everything else sits on top. The ramp is dark,
    // so each label gets a wide white halo to stay readable over a cell.
    const styleLayers = map.getStyle().layers;
    const firstLabel = styleLayers.find((layer) => layer.type === 'symbol')?.id;
    for (const layer of styleLayers) {
      if (layer.type === 'symbol' && layer.layout?.['text-field']) {
        map.setPaintProperty(layer.id, 'text-halo-color', LABEL_HALO.color);
        map.setPaintProperty(layer.id, 'text-halo-width', LABEL_HALO.width);
        map.setPaintProperty(layer.id, 'text-halo-blur', LABEL_HALO.blur);
      }
    }
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
      paint: {
        'line-color': MAP_COLORS.routeCasing,
        'line-width': routeWidth(null, ...ROUTE_WIDTH.casing),
      },
    });
    add({
      id: LAYER.routeLine,
      type: 'line',
      source: SOURCE.routes,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': routeColor(null),
        'line-width': routeWidth(null, ...ROUTE_WIDTH.line),
      },
    });
    add({
      id: LAYER.checkpoints,
      type: 'symbol',
      source: SOURCE.checkpoints,
      layout: {
        'icon-image': ['concat', ICON_PREFIX, ['get', 'icon']],
        'icon-size': checkpointIconSize(null),
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
    add({
      id: LAYER.stops,
      type: 'symbol',
      source: SOURCE.stops,
      layout: {
        'icon-image': ['concat', STOP_ICON_PREFIX, ['get', 'icon']],
        'icon-size': 0.85,
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
        'circle-stroke-color': MAP_COLORS.ring,
        'circle-stroke-width': 3.5,
      },
    });
    add({
      id: LAYER.trucks,
      type: 'circle',
      source: SOURCE.trucks,
      paint: {
        'circle-radius': truckRadius(null),
        'circle-color': MAP_COLORS.truck,
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
        'circle-color': [
          'match',
          ['get', 'kind'],
          'origin',
          MAP_COLORS.origin,
          MAP_COLORS.destination,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    });

    this.styleReady = true;
    this.pushRouteData();
    this.pushRouteStyle();
    this.pushSelection();
    this.pushGrid();
    this.announceReady();
  }

  /**
   * Says the map is ready, once. A style that installs while the context is lost says nothing:
   * the canvas is dead, so it is announced when the restore comes.
   */
  private announceReady(): void {
    if (this.announcedReady || this.contextLost) return;
    this.announcedReady = true;
    this.events.onReady();
  }

  /** Drawn and drawable: the style is in and the GL context is not lost. */
  private get live(): boolean {
    return this.styleReady && !this.contextLost;
  }

  private onContextLost(): void {
    this.contextLost = true;
    this.cancelHourFrame();
    this.hideReadout();
    this.hidePopup();
    this.events.onContextLost();
  }

  /**
   * MapLibre rebuilds its own GL resources and reloads the style, and refuses changes until that
   * is done. What this class pushed is pushed again once it is, and not before: until then the
   * map still counts as lost.
   */
  private onContextRestored(): void {
    const recover = () => {
      this.contextLost = false;
      // Before the first style install there is nothing to redraw; the install says ready.
      if (this.styleReady) {
        this.pushRouteData();
        this.pushRouteStyle();
        this.pushSelection();
        this.pushGrid();
        this.announceReady(); // an install that came while the context was lost
      }
      this.events.onRecovered();
    };
    if (this.map.isStyleLoaded()) recover();
    else this.map.once('idle', recover);
  }

  private source(id: string): GeoJsonSource | undefined {
    return this.map.getSource(id) as GeoJsonSource | undefined;
  }

  /** The routes, checkpoints and endpoints as map data. Only a new plan changes it. */
  private pushRouteData(): void {
    this.source(SOURCE.routes)?.setData(routeLines(this.routes));
    this.source(SOURCE.checkpoints)?.setData(checkpointPoints(this.routes));
    this.source(SOURCE.endpoints)?.setData(endpointPoints(this.routes));
    this.pushStops();
    this.pushTrucks();
  }

  /** How the selected route looks against the others. A selection changes this and no data. */
  private pushRouteStyle(): void {
    const map = this.map;
    const id = this.selectedRouteId;
    map.setPaintProperty(LAYER.routeLine, 'line-color', routeColor(id));
    map.setPaintProperty(LAYER.routeLine, 'line-width', routeWidth(id, ...ROUTE_WIDTH.line));
    map.setPaintProperty(LAYER.routeCasing, 'line-width', routeWidth(id, ...ROUTE_WIDTH.casing));
    map.setLayoutProperty(LAYER.checkpoints, 'icon-size', checkpointIconSize(id));
    map.setLayoutProperty(LAYER.checkpoints, 'symbol-sort-key', checkpointSortKey(id));
    map.setPaintProperty(LAYER.trucks, 'circle-radius', truckRadius(id));
  }

  /** The selected route's stops: a few points that follow the route selection and the plan. */
  private pushStops(): void {
    this.source(SOURCE.stops)?.setData(stopPoints(this.routes, this.selectedRouteId));
  }

  private pushSelection(): void {
    const sel = this.selectedCheckpoint;
    this.source(SOURCE.selected)?.setData(
      selectedPoint(this.routes, sel?.routeId ?? null, sel?.index ?? null),
    );
  }

  private pushGrid(): void {
    const source = this.source(SOURCE.grid);
    if (!source) return;
    // New cells start clean: state left from an earlier grid must not colour them.
    this.map.removeFeatureState({ source: SOURCE.grid });
    if (!this.grid) {
      source.setData(emptyCollection());
      return;
    }
    this.shownHour = this.hour?.get() ?? 0;
    this.pushTrucks();
    this.map.setPaintProperty(LAYER.gridFill, 'fill-color', gridFillColor(this.grid.levelNames));
    source.setData(gridCells(this.grid, this.shownHour));
  }

  /** The slider's path, at most once per frame: a drag can report faster than the screen draws. */
  private queueHour(hour: number): void {
    this.pendingHour = hour;
    if (this.hourFrame) return;
    this.hourFrame = requestAnimationFrame(() => {
      this.hourFrame = 0;
      const next = this.pendingHour;
      this.pendingHour = null;
      if (next !== null) this.showHour(next);
    });
  }

  private cancelHourFrame(): void {
    if (this.hourFrame) cancelAnimationFrame(this.hourFrame);
    this.hourFrame = 0;
    this.pendingHour = null;
  }

  /** Only the cells whose level differs from the hour on screen are touched. */
  private showHour(hour: number): void {
    const grid = this.grid;
    if (!grid || !this.live) return;
    for (const { cell, level } of diffHours(grid, this.shownHour, hour)) {
      this.map.setFeatureState({ source: SOURCE.grid, id: cell }, { level });
    }
    this.shownHour = hour;
    this.pushTrucks();
    // An open readout keeps saying what its cell holds at the hour now on screen.
    if (this.readout) {
      const { cell, checkpoint, popup, maxHeight } = this.readout;
      const words = this.readoutWords(cell, checkpoint);
      if (words) fillPopup(popup, words, maxHeight);
    }
  }

  /** The truck on each route at the hour on screen: a few points, set directly, no React. */
  private pushTrucks(): void {
    const source = this.source(SOURCE.trucks);
    if (!source) return;
    const grid = this.grid;
    const trucks = grid ? trucksAt(this.routes, hourInstant(grid, this.shownHour)) : [];
    source.setData(truckPoints(trucks));
  }

  // ---------- events ----------

  private hit(point: maplibregl.PointLike, layers: string[]) {
    if (!this.live) return [];
    const { x, y } = maplibregl.Point.convert(point);
    return this.map.queryRenderedFeatures(
      [
        [x - TAP_SLOP_PX, y - TAP_SLOP_PX],
        [x + TAP_SLOP_PX, y + TAP_SLOP_PX],
      ],
      { layers },
    );
  }

  /** Remembers the pointer; the cursor and the popup are worked out once per frame. */
  private onHover(point: maplibregl.Point): void {
    this.hoverPoint = point;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const latest = this.hoverPoint;
      this.hoverPoint = null;
      if (latest) this.showHover(latest);
    });
  }

  /** The pointer cursor over anything clickable, and the popup over a checkpoint. */
  private showHover(point: maplibregl.Point): void {
    const checkpoint = this.hit(point, [LAYER.checkpoints])[0];
    this.map.getCanvas().style.cursor =
      checkpoint ||
      this.hit(point, [LAYER.stops]).length > 0 ||
      this.hit(point, [LAYER.routeLine]).length > 0
        ? 'pointer'
        : '';
    if (!checkpoint || !window.matchMedia?.(HOVER_QUERY).matches) {
      this.hidePopup();
      return;
    }
    const { routeId, index } = checkpoint.properties as { routeId: string; index: number };
    const key = `${routeId}:${index}`;
    if (key === this.popupKey) return;
    const words = this.events.describeCheckpoint({ routeId, index });
    if (!words) {
      this.hidePopup();
      return;
    }
    const at = (checkpoint.geometry as unknown as { coordinates: [number, number] }).coordinates;
    this.hidePopup();
    this.popupKey = key;
    this.popup = this.openPopup(
      (anchor, width) =>
        new maplibregl.Popup({
          anchor,
          closeButton: false,
          closeOnClick: false,
          closeOnMove: false,
          focusAfterOpen: false,
          offset: 16,
          maxWidth: `${width}px`,
          className: 'checkpoint-popup',
        })
          .setLngLat(at)
          .addTo(this.map),
      words,
      HOVER_WIDTHS,
      at,
    ).popup;
  }

  /** What the cell's readout says at the hour on screen. */
  private readoutWords(cell: number, checkpoint: Reading | null): Reading | null {
    const grid = this.grid;
    if (!grid) return null;
    const heat = this.events.describeCell(levelKeyAt(grid, cell, this.shownHour), this.shownHour);
    // Opened from a checkpoint: both readings, each labelled with what it is.
    return heat ? labelReadings(checkpoint, heat) : null;
  }

  /**
   * Opens a popup on the side of its point that fits: inside the part of the map the panels leave
   * open, and clear of anything lying over the map, such as the key and the map's own controls.
   * Each width, widest first, and each anchor in turn is tried and measured, so a narrow map gets
   * a narrower popup whose text wraps. If none is both, see the ranking below.
   */
  private openPopup(
    make: (anchor: PopupAnchor, widthPx: number) => maplibregl.Popup,
    words: Reading,
    widths: readonly number[],
    at: maplibregl.LngLatLike,
  ): { popup: maplibregl.Popup; maxHeight: number } {
    const box = this.container.getBoundingClientRect();
    const open = {
      left: box.left + this.insets.left,
      top: box.top + this.insets.top,
      right: box.right - this.insets.right,
      bottom: box.bottom - this.insets.bottom,
    };
    const covered = this.events.coveredRects();
    // The map's own credit: worth keeping clear of, but less than a control.
    const creditEl = this.container.querySelector('.maplibregl-ctrl-attrib');
    const credit = creditEl ? [creditEl.getBoundingClientRect()] : [];
    const inOpenPart = (r: DOMRect) =>
      r.left >= open.left && r.right <= open.right && r.top >= open.top && r.bottom <= open.bottom;
    const overlaps = (r: DOMRect, rects: readonly DOMRect[]) =>
      rects.some(
        (c) => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top,
      );
    const clearOfCovered = (r: DOMRect) => !overlaps(r, covered) && !overlaps(r, credit);
    // How much of a popup lies over a set of rectangles, in px squared.
    const overlapArea = (r: DOMRect, rects: readonly DOMRect[]) =>
      rects.reduce(
        (sum, c) =>
          sum +
          Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)) *
            Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)),
        0,
      );
    // How far a popup is out of the open part. Every edge of it is hard: the trip bar, the sheet
    // and the slider bar lie over the map just as the controls do, and what runs under them is lost.
    const spill = (r: DOMRect) =>
      Math.max(0, open.left - r.left) +
      Math.max(0, r.right - open.right) +
      Math.max(0, open.top - r.top) +
      Math.max(0, r.bottom - open.bottom);
    // The room the open part leaves on the side of the point an anchor puts the popup: a popup
    // that cannot be that tall is capped there and scrolls, so it can always stay inside.
    const pointY = this.map.project(at).y + box.top;
    const roomFor = (anchor: PopupAnchor) => {
      const below = anchor.startsWith('top'); // anchored by its top: the popup hangs under the point
      const above = anchor.startsWith('bottom');
      const room = below
        ? open.bottom - pointY - POPUP_GAP_PX
        : above
          ? pointY - open.top - POPUP_GAP_PX
          : // beside the point, centred on it: as tall as twice the room to the nearer edge
            2 * Math.min(pointY - open.top, open.bottom - pointY);
      return Math.max(MIN_POPUP_HEIGHT_PX, Math.floor(room));
    };
    const made = (anchor: PopupAnchor, width: number) => {
      const popup = make(anchor, width);
      const maxHeight = roomFor(anchor);
      fillPopup(popup, words, maxHeight);
      return { popup, maxHeight };
    };
    const tries = widths.flatMap((width) =>
      POPUP_ANCHORS.map((anchor) => {
        const trial = made(anchor, width);
        const rect = trial.popup.getElement().getBoundingClientRect();
        trial.popup.remove();
        return { anchor, width, rect };
      }),
    );
    const fits = tries.find((t) => inOpenPart(t.rect) && clearOfCovered(t.rect));
    // Otherwise, among popups that are on the map, the one with least over the controls wins, then
    // least over the credit, then least spill (the first on a tie). One that is not on the map is
    // chosen only when none is.
    const rank = (t: (typeof tries)[number]) => [
      spill(t.rect) <= NEARLY_ON_MAP ? 0 : 1,
      overlapArea(t.rect, covered),
      overlapArea(t.rect, credit),
      spill(t.rect),
    ];
    const before = (a: number[], b: number[]) => {
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k];
      return false;
    };
    const chosen = fits ?? tries.reduce((best, t) => (before(rank(t), rank(best)) ? t : best));
    return made(chosen.anchor, chosen.width);
  }

  /** The readout for a cell, opened beside the point that was tapped. */
  private showReadout(
    cell: number,
    at: maplibregl.LngLatLike,
    checkpoint: Reading | null = null,
    ref: CheckpointRef | null = null,
  ): void {
    this.hideReadout();
    const words = this.readoutWords(cell, checkpoint);
    if (!words) return;
    const { popup, maxHeight } = this.openPopup(
      (anchor, width) =>
        new maplibregl.Popup({
          anchor,
          closeButton: true,
          closeOnClick: false,
          closeOnMove: false,
          focusAfterOpen: false,
          offset: 10,
          maxWidth: `${width}px`,
          className: 'cell-readout',
        })
          .setLngLat(at)
          .addTo(this.map),
      words,
      READOUT_WIDTHS,
      at,
    );
    popup.on('close', () => {
      if (this.readout?.popup === popup) this.readout = null;
    });
    this.readout = { cell, at, popup, maxHeight, checkpoint, ref };
  }

  private hideReadout(): void {
    const readout = this.readout;
    this.readout = null;
    readout?.popup.remove();
  }

  private hidePopup(): void {
    this.popup?.remove();
    this.popup = null;
    this.popupKey = null;
  }

  private onClick(point: maplibregl.Point): void {
    this.hideReadout();
    const stop = this.hit(point, [LAYER.stops])[0];
    if (stop) {
      // A stop sits on the route like a checkpoint but has no reading: the list shows it.
      this.events.onSelectStop(stop.properties as unknown as StopRef);
      this.hidePopup();
      this.events.onSpot(null);
      return;
    }
    const checkpoint = this.hit(point, [LAYER.checkpoints])[0];
    if (checkpoint) {
      const { routeId, index } = checkpoint.properties as { routeId: string; index: number };
      this.events.onSelectCheckpoint({ routeId, index });
      this.hidePopup();
      // The heatmap's reading at the checkpoint, beside the checkpoint's own: the cell is too
      // narrow to tap on a phone at the default fit, and a checkpoint is always within reach.
      const at = (checkpoint.geometry as unknown as { coordinates: [number, number] }).coordinates;
      const cell = this.cellAt(this.map.project(at));
      this.events.onSpot({ cell: cell ?? null, checkpoint: { routeId, index } });
      this.spotAt = at;
      this.spotWhat = { cell: cell ?? null, ref: { routeId, index } };
      if (!this.readoutOnMap || cell === undefined) return;
      const words = this.events.describeCheckpoint({ routeId, index });
      if (words) this.showReadout(cell, at, words, { routeId, index });
      return;
    }
    // A tap on a route line selects the route, and reads the heatmap cell under the finger as
    // well: at the default fit a cell is narrower than a line's tap reach, so the line would
    // otherwise always win and the cell could not be read without zooming in.
    const line = this.hit(point, [LAYER.routeLine])[0];
    if (line) this.events.onSelectRoute((line.properties as { id: string }).id);
    const cell = this.cellAt(point);
    this.spotAt = cell === undefined ? null : this.map.unproject(point);
    this.spotWhat = cell === undefined ? null : { cell, ref: null };
    this.events.onSpot(cell === undefined ? null : { cell, checkpoint: null });
    if (this.readoutOnMap && cell !== undefined) this.showReadout(cell, this.map.unproject(point));
  }

  /** The heatmap cell drawn under a screen point, if any. */
  private cellAt(point: maplibregl.PointLike): number | undefined {
    if (!this.live || !this.grid) return undefined;
    const cell = this.map.queryRenderedFeatures(point, { layers: [LAYER.gridFill] })[0];
    return typeof cell?.id === 'number' ? cell.id : undefined;
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
