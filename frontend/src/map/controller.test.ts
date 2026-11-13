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
let pointOnScreen = { x: 50, y: 50 };
let styleLoaded = true;
const onceHandlers = new Map<string, (event: unknown) => void>();
let queried: { id?: number }[] = [];
let queriedLines: { properties: { id: string } }[] = [];
const canvasListeners = new Map<string, () => void>();
let rectFor: (
  anchor: string,
  width: number,
) => { left: number; top: number; right: number; bottom: number };

const record =
  (method: string) =>
  (...args: unknown[]) => {
    log.push({ method, args });
  };

class StubPopup {
  anchor: string;
  width: number;
  removed = false;
  content: HTMLElement | null = null;
  constructor(options: { anchor: string; maxWidth?: string }) {
    this.anchor = options.anchor;
    this.width = parseInt(options.maxWidth ?? '0');
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
  contentStyle: Record<string, string> = {};
  getElement = () => ({
    getBoundingClientRect: () => rectFor(this.anchor, this.width),
    querySelector: () => ({ style: this.contentStyle }),
  });
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
    project = () => pointOnScreen;
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
  onContextLost: vi.fn(),
  onRecovered: vi.fn(),
  onSelectRoute: vi.fn(),
  onSelectCheckpoint: vi.fn(),
  onSpot: vi.fn(),
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
  pointOnScreen = { x: 50, y: 50 };
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
function checkpointUnder(controller: unknown, seen: unknown[][] = []) {
  const hit = {
    properties: { routeId: 'route-1', index: 3 },
    geometry: { coordinates: [-97, 35] },
  };
  const map = (controller as { map: { queryRenderedFeatures: unknown } }).map;
  const original = map.queryRenderedFeatures as (...args: unknown[]) => unknown[];
  map.queryRenderedFeatures = (area: unknown, options: { layers: string[] }) => {
    if (!options.layers.includes('checkpoints')) return original(area, options);
    seen.push(area as unknown[]);
    return [hit];
  };
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

test('with every side covered, the side that stays inside the open part wins over the first', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 100, right: 0, bottom: 0, left: 0 });
  ev.coveredRects.mockReturnValue([{ left: 0, top: 0, right: 400, bottom: 800 } as DOMRect]);
  // "bottom", the first side, hangs 60 px above the open part (under the trip bar); "top-left" is
  // inside it. Both are covered, so only the spill can tell them apart.
  placeAround({ bottom: [100, 40, 200, 140], 'top-left': [100, 200, 200, 250] });
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 200 } });

  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('top-left');
});

test('a popup that runs under the slider bar loses to one inside the open part, even over a control', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 0, right: 0, bottom: 200, left: 0 }); // open part ends at y 600
  ev.coveredRects.mockReturnValue([{ left: 300, top: 0, right: 400, bottom: 800 } as DOMRect]);
  // "bottom" is clear of the control but ends at 650, behind the bar; "left" is inside, over it.
  placeAround({ bottom: [100, 500, 200, 650], left: [310, 100, 390, 200] });
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 200 } });

  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('left');
});

test('a popup is capped to the room the open part leaves it, and scrolls', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 0, right: 0, bottom: 200, left: 0 }); // open part ends at y 600
  pointOnScreen = { x: 150, y: 400 };
  placeAround({ 'top-left': [150, 410, 350, 590] }); // the only side inside: it hangs below the point
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 400 } });

  const shown = popups.filter((p) => !p.removed)[0];
  expect(shown.anchor).toBe('top-left');
  expect(shown.contentStyle.maxHeight).toBe('172px'); // 600 - 400 - 28
  // The box is capped and does not scroll itself; the words inside it do.
  expect(shown.contentStyle.overflowY).toBe('hidden');
  expect(shown.content!.querySelector<HTMLElement>('.popup-scroll')!.style.overflowY).toBe('auto');
});

function bare() {
  const container = document.createElement('div');
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 800 }) as DOMRect;
  const ev = events();
  new MapController(container, ev);
  return ev;
}

test('a context lost and restored before the style installs reports the restore, then ready at the install', () => {
  const ev = bare();

  canvasListeners.get('webglcontextlost')!();
  canvasListeners.get('webglcontextrestored')!();
  expect(ev.onContextLost).toHaveBeenCalledTimes(1);
  expect(ev.onRecovered).toHaveBeenCalledTimes(1);
  expect(ev.onReady).not.toHaveBeenCalled();

  handlers.get('style.load')!({});
  expect(ev.onReady).toHaveBeenCalledTimes(1);
});

test('a style that installs while the context is lost says nothing until the restore', () => {
  const ev = bare();

  canvasListeners.get('webglcontextlost')!();
  handlers.get('style.load')!({});
  expect(ev.onReady).not.toHaveBeenCalled(); // the canvas is dead: not ready, and nothing recovered
  expect(ev.onRecovered).not.toHaveBeenCalled();

  canvasListeners.get('webglcontextrestored')!();
  expect(ev.onReady).toHaveBeenCalledTimes(1);
  expect(ev.onRecovered).toHaveBeenCalledTimes(1);
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
  const seen: unknown[][] = [];
  checkpointUnder(controller, seen);

  for (const x of [10, 20, 30]) handlers.get('mousemove')!({ point: { x, y: 10 } });
  expect(ev.describeCheckpoint).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  flushFrames();

  expect(ev.describeCheckpoint).toHaveBeenCalledTimes(1);
  expect(popups.filter((p) => !p.removed)).toHaveLength(1);
  // The one answer was for the last position, 30 (the query reaches 14 px each side of it).
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((area) => (area[0] as number[])[0] === 30 - 14)).toBe(true);
});

test('a lost WebGL context is reported as lost, and nothing is pushed while it is lost', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  flushFrames();
  expect(ev.onContextLost).not.toHaveBeenCalled();

  canvasListeners.get('webglcontextlost')!();
  expect(ev.onContextLost).toHaveBeenCalledTimes(1);

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

test('on a narrow map the readout is narrowed until it clears the control column', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 0, right: 0, bottom: 0, left: 0 });
  // The zoom column covers x 340-390. A popup 320 or 280 wide reaches into it on every side; one 240
  // wide, which wraps its text, does not.
  ev.coveredRects.mockReturnValue([{ left: 340, top: 0, right: 390, bottom: 200 } as DOMRect]);
  rectFor = (_anchor, width) => ({
    left: 80,
    top: 100,
    right: 80 + width,
    bottom: 100 + 40000 / width,
  });
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 100, y: 300 } });

  const shown = popups.filter((p) => !p.removed)[0];
  expect(shown.width).toBe(240); // the widest of 320, 280, 240 that still ends before x 340
  expect(ev.describeCell).toHaveBeenCalled();
});

test('when every side crosses something, a popup over the credit beats one over a control', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 0, right: 0, bottom: 0, left: 0 });
  const credit = document.createElement('div');
  credit.className = 'maplibregl-ctrl-attrib';
  credit.getBoundingClientRect = () => ({ left: 0, top: 700, right: 400, bottom: 730 }) as DOMRect;
  (controller as unknown as { container: HTMLElement }).container.append(credit);
  ev.coveredRects.mockReturnValue([{ left: 300, top: 0, right: 400, bottom: 200 } as DOMRect]);
  // "bottom" lies over a control; "top" lies over the credit; both are inside the open part.
  placeAround({ bottom: [250, 100, 350, 150], top: [100, 690, 200, 740] });
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 150, y: 200 } });

  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('top');
});

test('a readout is placed again when the panels change under it, and the map does not re-fit', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setInsets({ top: 250, right: 0, bottom: 0, left: 0 });
  pointOnScreen = { x: 150, y: 400 };
  // With a trip bar down to 250 the side above the point (220-390) pokes out and the one below it
  // (410-600) is used; when the trip bar goes and a sheet covers from 500 down, it is the other way.
  placeAround({ 'top-left': [150, 410, 350, 600], 'bottom-left': [150, 220, 350, 390] });
  queried = [{ id: 0 }];
  handlers.get('click')!({ point: { x: 150, y: 400 } });
  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('top-left');
  flushFrames();
  log.length = 0;

  controller.setInsets({ top: 0, right: 0, bottom: 300, left: 0 });

  const shown = popups.filter((p) => !p.removed);
  expect(shown).toHaveLength(1);
  expect(shown[0].anchor).toBe('bottom-left');
  expect(frames.size).toBe(0); // no fit queued while a readout is being read
  expect(log.some((c) => c.method === 'fitBounds')).toBe(false);
});

test('where the page shows the reading, a tap opens no popup and says what it landed on', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setReadoutOnMap(false);
  queried = [{ id: 2 }];

  // On a cell: not selecting anything, and no popup.
  handlers.get('click')!({ point: { x: 120, y: 300 } });
  expect(ev.onSpot).toHaveBeenLastCalledWith({ cell: 2, checkpoint: null });

  // On a route line: the route is selected and the cell is reported as well.
  queriedLines = [{ properties: { id: 'route-2' } }];
  handlers.get('click')!({ point: { x: 120, y: 300 } });
  expect(ev.onSelectRoute).toHaveBeenCalledWith('route-2');
  expect(ev.onSpot).toHaveBeenLastCalledWith({ cell: 2, checkpoint: null });

  // On a checkpoint: the checkpoint and the cell under it.
  checkpointUnder(controller);
  handlers.get('click')!({ point: { x: 120, y: 300 } });
  expect(ev.onSpot).toHaveBeenLastCalledWith({
    cell: 2,
    checkpoint: { routeId: 'route-1', index: 3 },
  });

  // On a checkpoint over no cell, the checkpoint alone.
  queried = [];
  handlers.get('click')!({ point: { x: 120, y: 300 } });
  expect(ev.onSpot).toHaveBeenLastCalledWith({
    cell: null,
    checkpoint: { routeId: 'route-1', index: 3 },
  });

  expect(popups).toHaveLength(0);
  expect(ev.describeCell).not.toHaveBeenCalled();
});

test('a tap on nothing reports no spot', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setReadoutOnMap(false);
  queried = [];

  handlers.get('click')!({ point: { x: 10, y: 10 } });

  expect(ev.onSpot).toHaveBeenCalledWith(null);
});

test('where the readout is on the map, a tap opens it and also reports the spot', () => {
  const { controller, ev, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [{ id: 0 }];

  handlers.get('click')!({ point: { x: 120, y: 300 } });

  expect(ev.onSpot).toHaveBeenCalledWith({ cell: 0, checkpoint: null });
  expect(popups.filter((p) => !p.removed)).toHaveLength(1);
});

test('moving the readout off the map closes an open popup', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [{ id: 0 }];
  handlers.get('click')!({ point: { x: 120, y: 300 } });
  expect(popups.filter((p) => !p.removed)).toHaveLength(1);

  controller.setReadoutOnMap(false);

  expect(popups.filter((p) => !p.removed)).toHaveLength(0);
});

test('a map that holds a spot for the page stays put when the panels move', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  controller.setReadoutOnMap(false);
  controller.setSpotOpen(true);

  controller.setInsets({ top: 0, right: 0, bottom: 300, left: 0 });
  expect(frames.size).toBe(0);

  controller.setSpotOpen(false);
  controller.setInsets({ top: 0, right: 0, bottom: 100, left: 0 });
  expect(frames.size).toBe(1);
});

/** A ResizeObserver the test can fire. */
function recordResizes() {
  let fire = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        fire = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  return () => fire();
}

test('an open readout is placed again when the map is resized, after the fit that follows', () => {
  const resized = recordResizes();
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  // Upright: the point is low on a tall map and the popup goes above it.
  pointOnScreen = { x: 150, y: 600 };
  placeAround({ bottom: [100, 500, 200, 570], top: [100, 630, 200, 700] });
  queried = [{ id: 0 }];
  handlers.get('click')!({ point: { x: 150, y: 600 } });
  expect(popups.filter((p) => !p.removed)[0].anchor).toBe('bottom');

  // On its side the map is short, so the point is no longer low and the old side is gone.
  const container = (controller as unknown as { container: HTMLElement }).container;
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 844, bottom: 390 }) as DOMRect;
  controller.setInsets({ top: 0, right: 0, bottom: 100, left: 0 });
  pointOnScreen = { x: 150, y: 100 };
  placeAround({ bottom: [100, -20, 200, 50], top: [100, 130, 200, 200] });
  resized();

  let shown = popups.filter((p) => !p.removed);
  expect(shown).toHaveLength(1);
  expect(shown[0].anchor).toBe('top');

  // The fit that the resize queued moves the point; the readout follows it once more.
  pointOnScreen = { x: 150, y: 250 };
  placeAround({ bottom: [100, 150, 200, 220], top: [100, 280, 200, 350] });
  flushFrames();
  shown = popups.filter((p) => !p.removed);
  expect(shown).toHaveLength(1);
  expect(shown[0].anchor).toBe('bottom');
});

test('a readout that is closed is not opened again by a resize', () => {
  const resized = recordResizes();
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [{ id: 0 }];
  handlers.get('click')!({ point: { x: 150, y: 600 } });
  controller.setReadoutOnMap(false);
  const before = popups.length;

  resized();
  flushFrames();

  expect(popups).toHaveLength(before);
});

test('the readout box is capped and fixed, the words scroll inside it, and a cue says when there is more', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [{ id: 0 }];
  handlers.get('click')!({ point: { x: 120, y: 300 } });
  const shown = popups.filter((p) => !p.removed)[0];

  // The box that holds MapLibre's close button never scrolls, so the button stays in its corner.
  expect(shown.contentStyle.overflowY).toBe('hidden');
  const root = shown.content!;
  const scroll = root.querySelector<HTMLElement>('.popup-scroll')!;
  const cue = root.querySelector<HTMLElement>('.popup-more')!;
  expect(scroll.textContent).toContain('low at 0');
  expect(cue.style.display).toBe('none'); // all of it fits

  const geometry = (height: number, client: number, top: number) => {
    Object.defineProperty(scroll, 'scrollHeight', { value: height, configurable: true });
    Object.defineProperty(scroll, 'clientHeight', { value: client, configurable: true });
    Object.defineProperty(scroll, 'scrollTop', { value: top, configurable: true });
    scroll.dispatchEvent(new Event('scroll'));
  };
  geometry(300, 100, 0);
  expect(cue.style.display).toBe('flex');
  geometry(300, 100, 200); // the end
  expect(cue.style.display).toBe('none');
});

test('a readout whose words change with the hour keeps its cap', () => {
  const { controller, holder } = setup();
  controller.setGrid(model(GRID), holder);
  queried = [{ id: 0 }];
  handlers.get('click')!({ point: { x: 120, y: 300 } });
  const shown = popups.filter((p) => !p.removed)[0];
  const cap = shown.contentStyle.maxHeight;
  expect(cap).toMatch(/px$/);
  // MapLibre builds the box again when the words are set; the cap is set on the new one.
  shown.contentStyle.maxHeight = '';
  shown.contentStyle.overflowY = '';

  holder.set(1);
  flushFrames();

  expect(shown.contentStyle.maxHeight).toBe(cap);
  expect(shown.contentStyle.overflowY).toBe('hidden');
});
