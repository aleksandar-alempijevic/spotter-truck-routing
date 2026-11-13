import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GridOut } from '../api/types';
import { buildRoutes } from '../test/fixtures';
import { buildPlanView } from '../plan/view';
import { buildGridModel, diffHours, type GridModel } from '../timeline/grid';
import { createHourHolder } from '../timeline/hourHolder';

// jsdom has no WebGL, so MapLibre is replaced by a stub that records what the controller asks of
// it. What is checked is the controller's own behaviour: what it writes, and when.
interface Call {
  method: string;
  args: unknown[];
}
const log: Call[] = [];
const handlers = new Map<string, (event: unknown) => void>();
const sources = new Map<string, { setData: (data: unknown) => void }>();
const popups: StubPopup[] = [];
let queried: { id?: number }[] = [];
let queriedLines: { properties: { id: string } }[] = [];
const canvasListeners = new Map<string, () => void>();
let rectFor: (anchor: string) => { left: number; top: number; right: number; bottom: number };

const record =
  (method: string) =>
  (...args: unknown[]) => {
    log.push({ method, args });
  };

class StubPopup {
  anchor: string;
  removed = false;
  constructor(options: { anchor: string }) {
    this.anchor = options.anchor;
    popups.push(this);
  }
  setLngLat = () => this;
  setDOMContent = () => this;
  addTo = () => this;
  on = () => this;
  remove = () => {
    this.removed = true;
    return this;
  };
  getElement = () => ({ getBoundingClientRect: () => rectFor(this.anchor) });
}

vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?url', () => ({ default: 'worker.js' }));
vi.mock('./icons', () => ({
  glyphImage: () => ({}),
  hatchImage: () => ({}),
  ICON_PIXEL_RATIO: 2,
}));
vi.mock('maplibre-gl', () => {
  class StubMap {
    touchZoomRotate = { disableRotation: () => {} };
    keyboard = { disableRotation: () => {} };
    private ids = new Set<string>();
    constructor() {}
    addControl = () => {};
    on = (event: string, handler: (event: unknown) => void) => {
      handlers.set(event, handler);
    };
    getCanvas = () => ({
      style: {},
      addEventListener: (event: string, handler: () => void) => canvasListeners.set(event, handler),
    });
    hasImage = () => false;
    addImage = () => {};
    getSource = (id: string) => sources.get(id);
    addSource = (id: string) => {
      sources.set(id, { setData: record(`setData:${id}`) });
    };
    getStyle = () => ({ layers: [] });
    getLayer = (id: string) => (this.ids.has(id) ? {} : undefined);
    addLayer = (spec: { id: string }) => this.ids.add(spec.id);
    setPaintProperty = record('setPaintProperty');
    setLayoutProperty = record('setLayoutProperty');
    removeFeatureState = record('removeFeatureState');
    setFeatureState = record('setFeatureState');
    queryRenderedFeatures = (_area: unknown, options: { layers: string[] }) =>
      options.layers.includes('grid-fill')
        ? queried
        : options.layers.includes('route-line')
          ? queriedLines
          : [];
    unproject = () => ({ lng: 0, lat: 0 });
    fitBounds = record('fitBounds');
    resize = () => {};
    remove = () => {};
    zoomTo = () => {};
    getZoom = () => 5;
    setStyle = () => {};
  }
  return {
    Map: StubMap,
    Popup: StubPopup,
    AttributionControl: class {},
    Point: { convert: (p: { x: number; y: number }) => p },
    setWorkerUrl: () => {},
  };
});

const { MapController } = await import('./controller');

const GRID: GridOut = {
  start: '2026-11-20T14:00:00Z',
  cell_degrees: 0.5,
  level_codes: ['low', 'moderate', 'high'],
  cells: [
    { lat: 35.25, lon: -97.25, levels: [0, 0, 1, 2, 2, 0] },
    { lat: 35.75, lon: -97.25, levels: [0, 0, 0, 0, 0, 0] },
    { lat: 36.25, lon: -97.25, levels: [null, 0, 0, 1, 2, 2] },
    { lat: 36.75, lon: -97.25, levels: [2, 2, 2, 2, 1, 1] },
  ],
};
const OTHER: GridOut = {
  ...GRID,
  cells: [
    { lat: 40.25, lon: -100.25, levels: [0, 1, 1, 0, 2, 2] },
    { lat: 40.75, lon: -100.25, levels: [0, 0, 0, 0, 0, 0] },
  ],
};
const model = (grid: GridOut): GridModel => buildGridModel(grid, grid.start);

let frames: Map<number, () => void>;
let nextFrame: number;
const flushFrames = () => {
  const due = [...frames.values()];
  frames.clear();
  due.forEach((run) => run());
};

const events = () => ({
  onReady: vi.fn(),
  onFailed: vi.fn(),
  onSelectRoute: vi.fn(),
  onSelectCheckpoint: vi.fn(),
  onBasemapUnavailable: vi.fn(),
  describeCheckpoint: vi.fn(() => ({ title: 'checkpoint', lines: [] })),
  describeCell: vi.fn((level: string, hour: number) => ({
    title: `${level} at ${hour}`,
    lines: [],
  })),
  coveredRects: vi.fn(() => [] as DOMRect[]),
});

function setup() {
  const container = document.createElement('div');
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 800 }) as DOMRect;
  const ev = events();
  const controller = new MapController(container, ev);
  handlers.get('style.load')!({});
  return { controller, ev, holder: createHourHolder(0) };
}

const featureStates = () =>
  log
    .filter((c) => c.method === 'setFeatureState')
    .map((c) => ({
      cell: (c.args[0] as { id: number }).id,
      level: (c.args[1] as { level: number }).level,
    }));

beforeEach(() => {
  log.length = 0;
  handlers.clear();
  sources.clear();
  popups.length = 0;
  queried = [];
  queriedLines = [];
  canvasListeners.clear();
  rectFor = () => ({ left: 100, top: 100, right: 200, bottom: 150 });
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    nextFrame += 1;
    frames.set(nextFrame, run);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

test('moving the slider writes only the cells whose level changed, once per frame', () => {
  const { controller, holder } = setup();
  const grid = model(GRID);
  controller.setGrid(grid, holder);
  log.length = 0;

  holder.set(1);
  expect(featureStates()).toEqual([]); // nothing is written until the frame
  flushFrames();
  expect(featureStates()).toEqual(diffHours(grid, 0, 1));
  expect(featureStates().length).toBe(1); // of four cells, one changed
  expect(log.filter((c) => c.method === 'setData:trucks').length).toBe(1);
});

test('hours reported within one frame make one write, from the hour on screen to the last one', () => {
  const { controller, holder } = setup();
  const grid = model(GRID);
  controller.setGrid(grid, holder);
  holder.set(1);
  flushFrames();
  log.length = 0;

  // Hour 2 changes cell 0 alone, and hour 4 changes cell 0 again and others: only the jump from
  // the hour on screen (1) to the last hour (4) is written.
  holder.set(2);
  holder.set(4);
  expect(frames.size).toBe(1);
  flushFrames();
  expect(featureStates()).toEqual(diffHours(grid, 1, 4));
  expect(featureStates().some((s) => s.cell === 1)).toBe(false); // cell 1 never changes
  expect(log.filter((c) => c.method === 'setData:trucks').length).toBe(1);
});

test('a new grid starts from the hour the holder shows, and the old one is no longer listened to', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  holder.set(3);
  flushFrames();

  const next = model(OTHER);
  log.length = 0;
  controller.setGrid(next, holder);
  expect(log.some((c) => c.method === 'removeFeatureState')).toBe(true);
  // The new grid is drawn at hour 3 as it is, so only a move from 3 writes anything.
  expect(featureStates()).toEqual([]);

  holder.set(4);
  flushFrames();
  expect(featureStates()).toEqual(diffHours(next, 3, 4));
  expect(featureStates().length).toBe(1);

  // Without a grid, the slider moves nothing on the map.
  controller.setGrid(null, holder);
  log.length = 0;
  holder.set(5);
  flushFrames();
  expect(featureStates()).toEqual([]);
});

test('the same routes again change nothing, so a form keystroke does not redraw the map', () => {
  const { controller } = setup();
  const view = buildPlanView(buildRoutes('mixed', { departure: GRID.start }));
  controller.setRoutes(view.routes);
  log.length = 0;
  controller.setRoutes(view.routes);
  expect(log).toEqual([]);

  const empty: never[] = [];
  controller.setRoutes(empty);
  log.length = 0;
  controller.setRoutes(empty);
  expect(log).toEqual([]);
});

test('a tap on a route line selects the route and reads the cell under the finger as well', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queriedLines = [{ properties: { id: 'route-2' } }];
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 120, y: 300 } });

  expect(ev.onSelectRoute).toHaveBeenCalledWith('route-2');
  expect(ev.describeCell).toHaveBeenCalledWith('low', 0);
  expect(popups.filter((p) => !p.removed)).toHaveLength(1);
});

test('a tap on a checkpoint selects it and opens no readout', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [{ id: 0 }];
  const hit = { properties: { routeId: 'route-1', index: 3 } };
  const map = (controller as unknown as { map: { queryRenderedFeatures: unknown } }).map;
  const original = map.queryRenderedFeatures as (...args: unknown[]) => unknown[];
  map.queryRenderedFeatures = (area: unknown, options: { layers: string[] }) =>
    options.layers.includes('checkpoints') ? [hit] : original(area, options);

  handlers.get('click')!({ point: { x: 120, y: 300 } });

  expect(ev.onSelectCheckpoint).toHaveBeenCalledWith({ routeId: 'route-1', index: 3 });
  expect(ev.describeCell).not.toHaveBeenCalled();
});

test('a readout takes the first side that is clear of what lies over the map', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 0, right: 0, bottom: 0, left: 0 });
  // Something covers 100-200 x 100-150, where an anchor of "bottom" would put the popup; every
  // other side is clear.
  ev.coveredRects.mockReturnValue([{ left: 90, top: 90, right: 210, bottom: 160 } as DOMRect]);
  rectFor = (anchor) =>
    anchor === 'bottom'
      ? { left: 100, top: 100, right: 200, bottom: 150 }
      : { left: 250, top: 300, right: 350, bottom: 350 };
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 200 } });

  const shown = popups.filter((p) => !p.removed);
  expect(shown).toHaveLength(1);
  expect(shown[0].anchor).toBe('top');
});

test('a lost WebGL context is reported as a failed map', () => {
  const { ev } = setup();
  expect(ev.onFailed).not.toHaveBeenCalled();
  canvasListeners.get('webglcontextlost')!();
  expect(ev.onFailed).toHaveBeenCalledTimes(1);
});
