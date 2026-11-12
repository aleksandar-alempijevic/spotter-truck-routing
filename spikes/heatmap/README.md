# Heatmap slider spike

Which way of switching the forecast hour keeps a 0–48 h slider smooth on a MapLibre map?

Stack: Vite 8.3.8, React 19.3.1, TypeScript, react-map-gl 8.1.3 (`react-map-gl/maplibre`), maplibre-gl 6.17.0, OpenFreeMap Positron basemap.
Scene: 3 synthetic LA→NYC routes, 326 checkpoint circles, and a deduplicated square grid of corridor cells (500 or 2,001 cells). Each cell has a risk level 0–4 for each of 49 hours, generated from storms drifting west to east. About 11.5% of cells change level from one hour to the next.

## Result

**Use feature state, and on each tick set it only for the cells whose level changes (`feature-diff`).** It is the only approach whose new colours show on the very next frame. Its main-thread cost grows with the number of changed cells, not with the size of the grid.

**Global state (`setGlobalStateProperty`) is a working runner-up.** Both a computed property key and an array lookup work in `fill-color`. The switch call costs nothing on the main thread. But every tick re-tiles the cell source in the worker, so the new colours appear about two frames later. On a CPU-only renderer that delay grows to about 110 ms.

Do not rebuild the GeoJSON on every tick (`rebuild`), and do not set feature state on every cell on every tick (`feature`). At 2,000 cells with a 4× slower CPU, each of them costs about 25–35 ms of main-thread time per tick.

Every approach made zero network requests during the drag.

## Approaches

| Name | What changes per tick |
|---|---|
| `global` | `setGlobalStateProperty('hour', h)`; `fill-color` reads `["get", ["concat", "r", ["to-string", ["global-state", "hour"]]]]` (computed key over properties `r0`..`r48`) |
| `global-array` | Same switch; `fill-color` reads `["at", ["global-state","hour"], ["array","number",49,["get","risk"]]]` |
| `global-lean` | `global-array` with a source that holds only the `risk` array, which is the realistic payload shape |
| `paint` | `setPaintProperty('fill-color', …["get", "r<h>"]…)`, which is global state without the API |
| `feature` | `setFeatureState({id}, {risk})` for **every** cell |
| `feature-diff` | `setFeatureState` only for cells whose level differs from the hour on screen |
| `layers` | 49 pre-built fill layers, one per hour; toggle `visibility` |
| `rebuild` | Baseline: build a new FeatureCollection for the hour and call `setData` |

No pre-rendered image per hour was built. A and B both work, and the `layers` variant covered "another approach".

## How it was measured

`bench/run.mjs` serves `dist/` (the production build) in-process and drives Chromium through Playwright 1.65 at 1280×800, DPR 1. For each approach and grid size it runs two tests:

1. **Sequential ticks.** For hours 1→48, it calls the switch and listens to MapLibre `render` events. In each frame it reads up to 6 probe pixels with `gl.readPixels`, on cells that change colour at that hour. **Change visible** is the time to the first frame whose probe pixels match the final colours. Every tick was checked to really change pixels (48/48 in all runs).
2. **Slider drag.** It drags the real `<input type=range>` 0→48→0 with the mouse (96 input events, about 16 ms apart plus Playwright round-trip time). It records **input→paint** (input event to the next frame, measured as requestAnimationFrame then setTimeout, which approximates INP), **frame gap** (the time between consecutive requestAnimationFrame callbacks), long tasks over 50 ms (PerformanceObserver), and network requests.

There were three runs, each with every approach at 500 and 2,001 cells:

- **gpu**: Chrome for Testing in headless mode on the real GPU. Renderer: `ANGLE Metal Renderer: Apple M1 Max`. Display at 120 Hz, so one frame is 8.3 ms.
- **gpu, CPU 4× slower**: the same, plus CDP `Emulation.setCPUThrottlingRate` set to 4. This approximates a mid-range laptop CPU on the main thread and the workers. The GPU is not slowed down.
- **shell**: Playwright's `chrome-headless-shell`. Renderer: `SwiftShader` (WebGL rasterised on the CPU), at 60 Hz.

The 4× CPU and shell runs were each repeated, and the repeats agree within noise. Raw JSON is in `bench/results-*.json`.

## Numbers (milliseconds; p50 / p95 unless marked)

### Real GPU (Apple M1 Max, 120 Hz)

| Approach | Cells | Change visible p50 / p95 | Drag input→paint p50 / p95 | Drag frame gap p95 / max | Long tasks |
|---|---|---|---|---|---|
| global | 500 | 9.0 / 15.5 | 1.7 / 1.9 | 10.2 / 24.9 | 0 |
| global-lean | 500 | 13.6 / 15.8 | 1.7 / 1.8 | 10.3 / 24.7 | 0 |
| feature | 500 | 5.2 / 6.5 | 3.0 / 3.3 | 10.0 / 10.4 | 0 |
| **feature-diff** | 500 | **1.2 / 1.4** | 1.4 / 1.6 | 10.0 / 10.4 | 0 |
| layers | 500 | 15.1 / 17.3 | 1.7 / 1.8 | 10.1 / 42.0 | 0 |
| rebuild | 500 | 9.2 / 15.9 | 1.8 / 1.9 | 10.3 / 26.6 | 0 |
| global | 2001 | 15.8 / 17.7 | 1.6 / 1.9 | 10.2 / 23.3 | 0 |
| global-array | 2001 | 15.8 / 18.0 | 1.6 / 1.8 | 10.3 / 24.7 | 0 |
| global-lean | 2001 | 15.6 / 24.9 | 1.8 / 2.0 | 10.3 / 33.5 | 0 |
| paint | 2001 | 17.1 / 24.5 | 1.6 / 1.8 | 10.3 / 49.8 | 1 (50 ms) |
| feature | 2001 | 9.1 / 10.3 | 9.4 / 9.8 | 10.0 / 10.4 | 0 |
| **feature-diff** | 2001 | **1.8 / 2.2** | 2.4 / 4.2 | 10.0 / 10.4 | 0 |
| layers | 2001 | 15.4 / 17.3 | 1.5 / 1.6 | 10.3 / 24.7 | 0 |
| rebuild | 2001 | 24.0 / 31.9 | 5.2 / 6.1 | 10.3 / 34.8 | 0 |

### Real GPU, CPU 4× slower (first run; the repeat is in `results-gpu-cpu4x-run2.json`)

| Approach | Cells | Change visible p50 / p95 | Drag input→paint p50 / p95 | Drag frame gap p95 / max | Long tasks |
|---|---|---|---|---|---|
| global | 500 | 25.9 / 29.9 | 7.3 / 12.7 | 10.2 / 39.8 | 0 |
| feature | 500 | 12.1 / 13.8 | 11.9 / 14.6 | 10.2 / 15.9 | 0 |
| **feature-diff** | 500 | **4.0 / 5.4** | 4.8 / 6.0 | 10.2 / 33.9 | 0 |
| rebuild | 500 | 17.6 / 27.3 | 7.5 / 8.7 | 10.1 / 33.0 | 0 |
| global | 2001 | 25.5 / 28.7 | 6.7 / 10.4 | 10.2 / 40.0 | 0 |
| global-lean | 2001 | 29.4 / 36.0 | 7.5 / 11.9 | 10.2 / 39.9 | 0 |
| paint | 2001 | 25.3 / 27.9 | 6.9 / 11.2 | 10.1 / 41.0 | 0 |
| feature | 2001 | 35.7 / 37.6 | **37.1 / 40.1** | **34.4** / 41.2 | 0 |
| **feature-diff** | 2001 | **8.3 / 10.2** | 9.9 / 12.8 | 10.1 / 10.4 | 0 |
| layers | 2001 | 32.9 / 35.9 | 11.4 / 14.5 | 10.1 / 40.4 | 0 |
| rebuild | 2001 | 49.8 / 59.8 | **24.2 / 29.0** | 24.2 / 57.5 | 1 (65 ms) |

### SwiftShader, CPU rasterisation (60 Hz; first run; the repeat is in `results-shell-run2.json`)

| Approach | Cells | Change visible p50 / p95 | Drag input→paint p50 / p95 | Drag frame gap p50 / p95 | Long tasks (count, total) |
|---|---|---|---|---|---|
| global | 500 | 111 / 113 | 43.8 / 50.6 | 33.3 / 50.1 | 9, 486 |
| feature | 500 | 16.2 / 18.2 | 44.8 / 50.2 | 16.7 / 33.4 | 5, 259 |
| **feature-diff** | 500 | **16.0 / 17.5** | 43.3 / 48.0 | 16.7 / 33.4 | 2, 127 |
| rebuild | 500 | 15.6 / 18.1 | 1.5 / 1.7 | 16.7 / 33.4 | 0 |
| global | 2001 | 109 / 110 | 45.9 / 48.2 | 33.3 / 50.1 | 2, 124 |
| global-lean | 2001 | 110 / 142 | 47.2 / 56.1 | 33.3 / 50.1 | 29, 1579 |
| layers | 2001 | 109 / 110 | 42.8 / 48.6 | 33.3 / 50.1 | 12, 651 |
| feature | 2001 | 13.6 / 22.1 | 52.9 / 59.4 | 16.7 / 50.1 | 96, 5074 |
| **feature-diff** | 2001 | **11.2 / 12.7** | 46.4 / 49.7 | 16.7 / 33.4 | 4, 221 |
| rebuild | 2001 | 25.0 / 67.8 | 5.2 / 53.4 | 16.7 / 50.0 | 44, 2285 |

`bench/table.mjs` prints the full tables, with every approach, from the JSON files.

## Reading the numbers

- **Global state, `paint`, and `layers` all take the same path: a worker re-tile on every tick.** Changing a global-state value that a data-driven paint property reads goes through `layer.setPaintProperty`, which returns "needs relayout". `Style._updateLayer` then reloads the source's tiles in the worker. This comes from reading `Style._applyGlobalStateChanges` and `_updatePaintProperty` in `maplibre-gl-dev.mjs` 6.17.0. Toggling `visibility` also reloads the source. The measurements fit this: these approaches produce **2 map renders per slider input** (192 renders for 96 inputs), while `feature-diff` produces 1. Their change-visible time is about 2 frames on the GPU and a fairly constant ~110 ms on SwiftShader, whatever the cell count. *Inferred, not measured:* the first frame after the switch redraws the old colours, and only the second shows the re-tiled data, so the delay is about two full map renders. A symbol fade is not the cause: `fadeDuration=0` made no difference (`results-shell-fade0.json`).
- **Feature state is applied while the next frame is drawn, without a worker.** Setting it on all 2,001 cells costs about 9 ms per tick on the M1 and about 35 ms with a 4× slower CPU. That is enough to drop the drag to about 30 fps (frame gap p95 34 ms). Setting only the ~12% of cells that change cuts the cost to about 2 ms and about 8 ms respectively, and the drag stays at full frame rate.
  - Worst case, *inferred:* a click that jumps from +0 h to +48 h changes most cells, so it costs about what one `feature` tick costs. That is under 40 ms even with a 4× slower CPU.
- **Rebuilding the GeoJSON** pays for re-serialising and re-tiling 2,000 polygons on the main thread on every tick: input→paint 24 ms and a 65 ms long task with a 4× slower CPU.
  - On SwiftShader, `rebuild` shows the lowest input→paint, because `setData` does not trigger an immediate repaint. Its change-visible time and long tasks are still worse than `feature-diff` at 2,000 cells.
- The computed-key variant (`global`) and the array variant (`global-array`, `global-lean`) perform the same. Dropping the 49 duplicate `rN` properties (`global-lean`) did not make the re-tile measurably faster.

## What headless means for these numbers

- **The `gpu` run renders on a real GPU.** Headless Chrome for Testing with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` reports the M1 Max as its WebGL renderer, so these are real-hardware numbers, but for a high-end laptop.
  - The 4× CPU run approximates a mid-range machine. It slows only the CPU side (main thread and workers), which is where all the approaches differ. GPU fill cost is the same for all of them (one fill layer of up to 2,000 quads).
- **The `shell` run has no GPU.** SwiftShader rasterises WebGL on the CPU, so every map frame costs 16–50 ms of CPU time, competing with the workers. Treat it as a pessimistic proxy for a machine with hardware acceleration turned off or a virtual machine. The absolute numbers are inflated, but the ranking (feature-diff best for latency, global state about 110 ms) holds.
- **The drag pacing is not exactly 60 Hz.** Each Playwright `mouse.move` waits for the renderer, so the 96 moves took about 2.4 s on the GPU (about 25 ms apart) and about 10 s on SwiftShader. A human dragging faster sends more inputs per frame. The browser coalesces those, so the per-frame cost is what matters (*inferred*).
- **`readPixels` stalls the GPU pipeline.** It runs only in the sequential-tick test, never during the drag, so it adds a small constant to the change-visible numbers for every approach.

## Gotchas found

1. **Worker under Vite.** maplibre-gl 6 is ESM-only and loads its worker from `new URL('./maplibre-gl-worker.mjs?v=…', import.meta.url)`. Neither Vite mode finds it:
   - The dev server pre-bundles `maplibre-gl` into `node_modules/.vite/deps/`, where the worker file is missing (HTTP 504).
   - `vite build` emits no worker file, because the file name is built at runtime, so the request returns 404.
   - In both cases the map never loads: "Worker failed to load. Check that the worker URL is correct." Both were reproduced with `?worker=default`.
   - Fix: `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'` plus `setWorkerUrl(workerUrl)` before the first map is created. The react-map-gl `<Map workerUrl={…}>` prop does the same thing. The worker is self-contained (no imports), so `?url` is enough.
2. **No default export.** maplibre-gl 6 has no default export, so `import maplibregl from 'maplibre-gl'` is a TypeScript error (TS1192). Use `import * as maplibregl from 'maplibre-gl'` and pass it as `mapLib`. react-map-gl accepts the namespace object (`'Map' in module`).
3. **Global state in `fill-color` with a computed key works.**
   - `["get", ["concat", "r", ["to-string", ["global-state", "hour"]]]]` renders the correct colours. Screenshots `bench/shots/global-2000-h24.png` and `feature-2000-h24.png`, both at +24 h, show the same colours when compared by eye.
   - `["at", ["global-state","hour"], ["array", "number", 49, ["get","risk"]]]` also works; array properties survive GeoJSON tiling.
   - The value was wrapped in `to-number` before `match`; the bare `get` was not tested.
   - Call `setGlobalStateProperty('hour', 0)` in `onLoad`, or declare a `state` default in the style. Without either, `global-state` returns null.
   - The catch is that it is **not** a cheap repaint: it re-tiles the source in the worker on every change (see above).
4. **Feature state needs numeric feature `id`s** (or `promoteId`). The cells need `id` on each feature. Data expressions with `feature-state` are allowed only in paint properties ([MapLibre/style spec expressions](https://maplibre.org/maplibre-style-spec/expressions/)). Feature state is stored per source, so it should survive tile reloads on zoom (*inferred*; zooming was not tested).
5. **Bundle size** (`vite build`, minified):

   | File | Raw | Gzip |
   |---|---|---|
   | Lazy map chunk (`App-*.js`: maplibre-gl + react-map-gl + spike code) | 1,129 kB | 304–308 kB |
   | Worker (`maplibre-gl-worker-*.mjs`, separate file) | 520 kB | 148 kB |
   | CSS | 71 kB | 10 kB |
   | Entry (React + react-dom) | 222 kB | 69 kB |

   Load the map with `React.lazy` so the form can render before about 450 kB gzip of map code arrives. Vite warns that the chunk is over 500 kB; that is expected.
6. **Spike payload is not production shape.** The spike cell GeoJSON is 1.6 MB raw at 2,000 cells, because each cell carries `r0..r48` plus the array. For the real app, send cell bounds plus a 49-character level string or array per cell, and build polygons on the client (*inferred*; not measured here).

## Running it

```sh
npm install
npm run dev                       # http://localhost:5173/?approach=feature-diff&cells=2000
npm run build
# CHROME_PATH is optional; it reuses an installed Chromium instead of `npx playwright install`.
CHROME_PATH=…/chrome-headless-shell node bench/run.mjs --mode=shell
CHROME_PATH="…/Google Chrome for Testing" node bench/run.mjs --mode=gpu [--throttle=4]
node bench/table.mjs bench/results-gpu.json
```

Options: `--approaches=a,b`, `--cells=500,2000`, `--extra=key=value` (extra URL query), `--shots=1`.
URL query: `approach`, `cells`, `worker=default` (skips `setWorkerUrl`), `style`, `fade`.
