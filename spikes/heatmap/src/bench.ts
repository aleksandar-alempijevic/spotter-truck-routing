// Measurement hooks exposed on window.__spike for the Playwright runner.
import type { Map as MlMap } from 'maplibre-gl';
import { HOURS, type SpikeData } from './data';

type Px = [number, number, number, number];

export interface TickResult {
  hour: number;
  syncMs: number; // time spent inside the switch call itself
  firstRenderMs: number; // to the first map frame after the switch
  visibleMs: number; // to the first frame where all probe pixels show the final colour
  idleMs: number; // to map 'idle'
  renders: number;
  probes: number;
  changed: boolean; // at least one probe pixel actually changed colour
}

export function installBenchHooks(map: MlMap, data: SpikeData, approach: string, setHour: (h: number) => void) {
  let current = 0;
  const canvas = map.getCanvas();
  const gl = (map as unknown as { painter: { context: { gl: WebGLRenderingContext } } }).painter.context.gl;

  const readPx = (pts: [number, number][]): Px[] => {
    const dpr = canvas.width / canvas.clientWidth;
    const buf = new Uint8Array(4);
    return pts.map(([x, y]) => {
      gl.readPixels(Math.round(x * dpr), Math.round(canvas.height - y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2], buf[3]];
    });
  };
  const same = (a: Px[], b: Px[]) => a.every((p, i) => p.every((v, k) => Math.abs(v - b[i][k]) <= 2));

  const pickProbes = (h: number): [number, number][] => {
    const out: [number, number][] = [];
    const n = data.cells.features.length;
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    const half = data.cellSizeDeg / 2;
    for (let k = 0; k < n && out.length < 6; k++) {
      const i = (k * 7919) % n; // spread the probes across the corridor
      if (data.risks[i * HOURS + h] === data.risks[i * HOURS + current]) continue;
      const ring = data.cells.features[i].geometry.coordinates[0];
      // Sample a quarter in from the corner, off the route centreline and checkpoints.
      const p = map.project([ring[0][0] + half * 0.5, ring[0][1] + half * 0.5]);
      if (p.x < 5 || p.y < 5 || p.x > w - 5 || p.y > hgt - 90) continue;
      out.push([p.x, p.y]);
    }
    return out;
  };

  const nextRender = () => new Promise<void>((res) => { map.once('render', () => res()); map.triggerRepaint(); });

  async function measureTick(h: number): Promise<TickResult> {
    const probes = pickProbes(h);
    let before: Px[] = [];
    await new Promise<void>((res) => { map.once('render', () => { before = readPx(probes); res(); }); map.triggerRepaint(); });
    await new Promise((r) => setTimeout(r, 30));

    const frames: { t: number; px: Px[] }[] = [];
    const onRender = () => frames.push({ t: performance.now(), px: readPx(probes) });
    map.on('render', onRender);
    const t0 = performance.now();
    setHour(h);
    const syncMs = performance.now() - t0;
    await new Promise<void>((res) => {
      const done = () => { clearTimeout(to); res(); };
      const to = setTimeout(() => { map.off('idle', done); res(); }, 8000);
      map.once('idle', done);
    });
    const idleMs = performance.now() - t0;
    map.off('render', onRender);
    current = h;
    const final = frames.length ? frames[frames.length - 1].px : before;
    const firstVisible = frames.find((f) => same(f.px, final));
    return {
      hour: h, syncMs,
      firstRenderMs: frames.length ? frames[0].t - t0 : NaN,
      visibleMs: firstVisible ? firstVisible.t - t0 : NaN,
      idleMs, renders: frames.length, probes: probes.length, changed: !same(before, final),
    };
  }

  // Free-running recorder for the drag scrub: frame gaps, long tasks, input -> next frame.
  function startRecording() {
    const rec = { frames: [] as number[], longTasks: [] as { start: number; dur: number }[], inputs: [] as number[], renders: 0 };
    let running = true;
    let last = performance.now();
    const loop = (t: number) => { rec.frames.push(t - last); last = t; if (running) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) rec.longTasks.push({ start: e.startTime, dur: e.duration });
    });
    po.observe({ type: 'longtask', buffered: false });
    const slider = document.getElementById('hour')!;
    const onInput = (e: Event) => {
      const ts = e.timeStamp;
      requestAnimationFrame(() => setTimeout(() => rec.inputs.push(performance.now() - ts), 0));
    };
    slider.addEventListener('input', onInput, { capture: true });
    const onRender = () => { rec.renders++; };
    map.on('render', onRender);
    return () => {
      running = false; po.disconnect(); slider.removeEventListener('input', onInput, { capture: true }); map.off('render', onRender);
      return rec;
    };
  }

  let stop: null | (() => unknown) = null;
  const w = window as unknown as Record<string, unknown>;
  w.__spike = {
    approach,
    cells: data.cells.features.length,
    measureTick,
    nextRender,
    start: () => { stop = startRecording(); },
    stop: () => stop?.(),
    waitIdle: () => new Promise<void>((res) => { if (map.loaded() && map.areTilesLoaded()) res(); else map.once('idle', () => res()); }),
    renderer: () => {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    },
  };
  w.__spikeReady = true;
}
