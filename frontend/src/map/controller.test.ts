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
let styleLayers: { id: string; type: string; layout?: Record<string, unknown> }[] = [];
let styleLoaded = true;
const onceHandlers = new Map<string, (event: unknown) => void>();
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
  content: HTMLElement | null = null;
  constructor(options: { anchor: string }) {
    this.anchor = options.anchor;
    popups.push(this);
  }
  setLngLat = () => this;
  setDOMContent = (content: HTMLElement) => {
    this.content = content;
    return this;
  };
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
    getStyle = () => ({ layers: styleLayers });
    getLayer = (id: string) => (this.ids.has(id) ? {} : undefined);
    addLayer = (spec: { id: string }, before?: string) => {
      this.ids.add(spec.id);
      log.push({ method: 'addLayer', args: [spec.id, before] });
    };
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
    project = () => ({ x: 50, y: 50 });
    fitBounds = record('fitBounds');
    isStyleLoaded = () => styleLoaded;
    once = (event: string, handler: (event: unknown) => void) => {
      onceHandlers.set(event, handler);
    };
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
  onRecovered: vi.fn(),
  onSelectRoute: vi.fn(),
  onSelectCheckpoint: vi.fn(),
  onBasemapUnavailable: vi.fn(),
  describeCheckpoint: vi.fn(() => ({ title: 'checkpoint', lines: [] as string[] })),
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
  styleLayers = [];
  styleLoaded = true;
  onceHandlers.clear();
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

/** Makes the next query for checkpoints find one, so a click lands on it. */
function checkpointUnder(controller: unknown) {
  const hit = {
    properties: { routeId: 'route-1', index: 3 },
    geometry: { coordinates: [-97, 35] },
  };
  const map = (controller as { map: { queryRenderedFeatures: unknown } }).map;
  const original = map.queryRenderedFeatures as (...args: unknown[]) => unknown[];
  map.queryRenderedFeatures = (area: unknown, options: { layers: string[] }) =>
    options.layers.includes('checkpoints') ? [hit] : original(area, options);
}

test('a tap on a checkpoint selects it and opens one readout that labels both readings', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [{ id: 0 }];
  ev.describeCheckpoint.mockReturnValue({
    title: 'Route 1 · mile 75',
    lines: ['Moderate', 'Wind 12 mph', 'Set by wind'],
  });
  checkpointUnder(controller);

  handlers.get('click')!({ point: { x: 120, y: 300 } });

  expect(ev.onSelectCheckpoint).toHaveBeenCalledWith({ routeId: 'route-1', index: 3 });
  const shown = popups.filter((p) => !p.removed);
  expect(shown).toHaveLength(1);
  const text = shown[0].content!.textContent!;
  expect(text).toContain('Route 1 · mile 75');
  expect(text).toContain('Checkpoint at arrival: Moderate');
  expect(text).toContain('Wind 12 mph');
  expect(text).toContain('Heatmap at slider hour: low at 0');
});

test('the checkpoint readout follows the slider for its heatmap line and keeps the checkpoint line', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [{ id: 2 }];
  ev.describeCheckpoint.mockReturnValue({ title: 'Route 1 · mile 75', lines: ['Moderate'] });
  checkpointUnder(controller);
  handlers.get('click')!({ point: { x: 120, y: 300 } });
  const popup = popups.filter((p) => !p.removed)[0];

  holder.set(1);
  flushFrames();

  expect(popup.content!.textContent).toContain('Heatmap at slider hour: low at 1');
  expect(popup.content!.textContent).toContain('Checkpoint at arrival: Moderate');
});

test('a tap on a checkpoint over no cell opens no readout', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [];
  checkpointUnder(controller);

  handlers.get('click')!({ point: { x: 120, y: 300 } });

  expect(popups.filter((p) => !p.removed)).toHaveLength(0);
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

/** The clear sides: the rectangle each anchor gets is `rects[anchor]`, or `elsewhere` for the rest. */
function placeAround(rects: Record<string, [number, number, number, number]>) {
  rectFor = (anchor) => {
    const r = rects[anchor] ?? [500, 500, 600, 550];
    return { left: r[0], top: r[1], right: r[2], bottom: r[3] };
  };
}

test('a popup stays out of the part of the map the panels cover', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  // A pane covers the left 300 px: sides that land there are not tried again once one fits.
  controller.setInsets({ top: 0, right: 0, bottom: 0, left: 300 });
  placeAround({ bottom: [100, 100, 200, 150], top: [310, 100, 390, 150] });
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 200 } });

  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('top');
});

test('with every side covered, a popup still opens, on a side inside the open part', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  ev.coveredRects.mockReturnValue([{ left: 0, top: 0, right: 400, bottom: 800 } as DOMRect]);
  placeAround({ bottom: [100, 100, 200, 150], 'bottom-left': [120, 100, 220, 150] });
  controller.setInsets({ top: 0, right: 0, bottom: 0, left: 0 });
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 200 } });

  // Nothing is clear, so the first side inside the open part stands.
  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('bottom');
});

test('with no side inside the open part, the first side stands', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 790, right: 0, bottom: 0, left: 0 });
  placeAround({});
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 200 } });

  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('bottom');
});

test('a popup taller than the open part takes the side that spills least out of it', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 100, right: 0, bottom: 0, left: 0 });
  // Every side pokes out of the open part (top 100): "bottom" by 60 px, "right" by 10, the rest by 90.
  placeAround({
    bottom: [100, 40, 200, 140],
    right: [100, 90, 200, 190],
    top: [100, 10, 200, 110],
    'top-left': [100, 10, 200, 110],
  });
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 200 } });

  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('right');
});

test('mouse movement is answered once per frame, with the last position', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  checkpointUnder(controller);

  for (const x of [10, 20, 30]) handlers.get('mousemove')!({ point: { x, y: 10 } });
  expect(ev.describeCheckpoint).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  flushFrames();

  expect(ev.describeCheckpoint).toHaveBeenCalledTimes(1);
  expect(popups.filter((p) => !p.removed)).toHaveLength(1);
});

test('a lost WebGL context is reported as a failed map, and nothing is pushed while it is lost', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  flushFrames();
  expect(ev.onFailed).not.toHaveBeenCalled();

  canvasListeners.get('webglcontextlost')!();
  expect(ev.onFailed).toHaveBeenCalledTimes(1);

  log.length = 0;
  const view = buildPlanView(buildRoutes('mixed', { departure: GRID.start }));
  controller.setRoutes(view.routes);
  controller.setSelection('route-1', null);
  holder.set(2);
  flushFrames();
  expect(log).toEqual([]);
});

test('a restored context draws everything again, and the slider writes again after it', () => {
  const { controller, ev, holder } = setup();
  const grid = model(GRID);
  const view = buildPlanView(buildRoutes('mixed', { departure: GRID.start }));
  controller.setRoutes(view.routes);
  controller.setGrid(grid, holder);
  canvasListeners.get('webglcontextlost')!();
  holder.set(2); // missed while lost
  flushFrames();

  log.length = 0;
  canvasListeners.get('webglcontextrestored')!();

  expect(ev.onRecovered).toHaveBeenCalledTimes(1);
  const pushed = log.map((c) => c.method);
  for (const source of ['routes', 'checkpoints', 'endpoints', 'trucks', 'grid-cells']) {
    expect(pushed).toContain(`setData:${source}`);
  }
  expect(pushed).toContain('removeFeatureState'); // the grid starts clean, at the holder's hour

  log.length = 0;
  holder.set(3);
  flushFrames();
  expect(featureStates()).toEqual(diffHours(grid, 2, 3));
});

test('the heatmap goes under the basemap labels, and each label gets a halo that reads over a dark cell', () => {
  styleLayers = [
    { id: 'roads', type: 'line' },
    { id: 'label_city', type: 'symbol', layout: { 'text-field': '{name}' } },
    { id: 'shield', type: 'symbol', layout: { 'icon-image': 'x' } },
  ];
  setup();

  const added = log.filter((c) => c.method === 'addLayer');
  const grid = added.filter((c) => c.args[0] === 'grid-fill' || c.args[0] === 'grid-no-forecast');
  expect(grid.map((c) => c.args[1])).toEqual(['label_city', 'label_city']);
  const route = added.find((c) => c.args[0] === 'route-line')!;
  expect(route.args[1]).toBeUndefined(); // routes and marks sit on top of everything
  const halos = log.filter(
    (c) => c.method === 'setPaintProperty' && c.args[1] === 'text-halo-width',
  );
  expect(halos.map((c) => c.args[0])).toEqual(['label_city']); // text labels only
  expect(halos[0].args[2]).toBeGreaterThanOrEqual(2);
});

test('a restored context waits for the style to finish loading before it draws or reports back', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  canvasListeners.get('webglcontextlost')!();
  styleLoaded = false; // MapLibre is reloading the style: it refuses changes until it is done

  log.length = 0;
  canvasListeners.get('webglcontextrestored')!();
  holder.set(2);
  flushFrames();
  expect(log).toEqual([]);
  expect(ev.onRecovered).not.toHaveBeenCalled();

  styleLoaded = true;
  onceHandlers.get('idle')!({});
  expect(ev.onRecovered).toHaveBeenCalledTimes(1);
  expect(log.some((c) => c.method === 'setData:grid-cells')).toBe(true);
});
