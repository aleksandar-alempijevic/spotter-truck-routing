# Performance

What was measured, on which build and how, and what was not measured. Every figure here comes from a recorded run; the scripts that make the runs are in the repository, so each can be repeated, except the WebGL program-link probe and the traces behind the slow-frame diagnosis, which are outside it. None of these numbers is from the hosted app.

## Planning a trip (backend)

Planning is two requests: routes first, so they reach the map before the weather finishes, then weather risk. The checks below spend live provider quota, so they are outside `make check`.

### Routes

`backend/live_check.py` runs the routes endpoint over seven trips with the real TomTom, at 25-mile spacing and an 80,000 lb load (2026-11-12):

| Trip | Routes | Latency | Response | TomTom calls |
|---|---|---|---|---|
| Los Angeles to New York | 3 (2 from TomTom, 1 via Albuquerque) | 14.7 s | 145 kB | 3 |
| Seattle to Miami | 3 | 12.0 s | 181 kB | 1 |
| Chicago to Los Angeles | 2 (no distinct third) on the first run; 3 after the search was widened | 8.5 s | 66 kB | 3 |
| Dallas to San Francisco | 3 | 8.4 s | 106 kB | 1 |
| Denver to Atlanta | 3 | 4.1 s | 73 kB | 1 |
| Chicago to Indianapolis | 3 | 1.9 s | 12 kB | 1 |
| Dallas to Houston | 3 | 1.6 s | 12 kB | 1 |

After the search was widened, Chicago to Los Angeles took 6 TomTom calls and returned three routes in 8.8 s and 100 kB. Lines carry 100 to 2,100 points after reduction. These are one-off measurements: TomTom's latency on long trips varies a lot between identical calls.

### Weather

`backend/live_weather_report_check.py` routed Seattle to Miami (the trip with the most locations) at 25-mile spacing and 80,000 lb with one TomTom call (423 checkpoints) and sent the routes to the weather endpoint (2026-11-13). The cold request needed 515 Open-Meteo locations (379 checkpoint cells and 136 cells only the heatmap needs; the grid has 436 display cells) in 4 chunks, finished in 1.05 s with no wait and returned 166 kB. The repeat fetched nothing and returned the same body in 0.12 s, because the forecast cache is shared by every request.

The weather source is free and keyless but limited per address: [assumptions.md](assumptions.md#weather) gives the quota, what happens at 10-mile spacing on a long trip, and the 1,800-location refusal. `backend/live_weather_check.py` measures that quota behaviour.

With rest breaks on (the switch is off by default), stops add forecast locations. The additions come from synthetic routes, not a live trip: a stop adds a location only when its cell is new, which on a long trip is about one per stop at 25 and 50-mile spacing (up to about 25 more) and about half that at 10 miles.

### Address search

`backend/live_address_check.py` ran 8 typed queries through the endpoint against Geoapify (2026-11-12): all answered with HTTP 200 in 0.66 to 2.79 s.

## The map and the slider (frontend)

**Method.** A scripted pointer drag of the slider across every hour and back, in headless Chromium (Chrome for Testing 153.0.8010.12) at 390 by 844 with touch emulation, 3 runs for each of four configurations: 267 and 520 grid cells, each with a 4x CPU slowdown and without. The script is `frontend/scripts/measure-slider.mjs`. The app was a production build served by `vite preview` and fed by a typed stand-in API, so no provider was called.

**Result, 12 drags (the earlier run, at `de0ce4b`):**

| Measure | Result |
|---|---|
| Long tasks over 50 ms | 0 |
| `pointermove` events over 16 ms | 0 |
| Requests during the drag | 0 (API or other) |
| Frame gap, median and 95th percentile | 16.7 ms and 16.7 to 16.8 ms |
| Frames over 50 ms | 0 in this run, at a departure whose minute was not pinned; see the slow-frame section below |

The slider recolours only the heatmap cells whose level changed and makes no request, which is what these numbers show. Whether the drag is free of slow frames depends on the departure minute; see the section below.

These runs predate the rest-break and stop-weather UI (the stop rows, the stop marks and the stopped trucks). The build sizes below are those of `57091ed`.

**The slow frame, its cause and its fix.** On a build before the fix, each drag showed one isolated frame of 100 to 217 ms, with rest breaks on or off alike. A trace (the probe and the traces were kept outside the repository) found the cause in the app: the first time the map draws a moving truck, MapLibre compiles a WebGL program for the trucks circle layer, a constant colour with a per-feature radius that no other layer uses, and under headless software GL that compile blocks the GPU process for about 117 ms. The layer is empty while the slider sits at hour 0, because no truck is driving yet (`truckPoints`). The slider opens at hour 0 only for a departure under 30 minutes past the hour (`initialHour` in `timeline/grid.ts`), so the first draw landed on the first step of the drag, and the result of a run depended on the minute it was made. That is why the earlier runs disagreed.

The fix: when the slider first has no truck to show, the controller draws one truck at the first route's start, under the endpoint marks, so the program is built when the plan appears; the first frame drawn after the trucks source loads replaces it with what the hour says (`warmTrucks` in `map/controller.ts`, `warmupTruck` in `map/features.ts`). It does nothing when a truck is already on the road, so a departure at :45 is unchanged.

Measured after the fix, at `21148f5`, where the placeholder truck was replaced at the next idle moment of the map (the slider drag of `frontend/scripts/measure-slider.mjs`, with a separate probe, outside the repository, that also recorded WebGL program links; at 390 by 844 with touch, software WebGL, no warm-up pass, one drag per run):

| Departure | CPU | Runs | Frames over 50 ms | Largest gap |
|---|---|---|---|---|
| :10 (slider opens at hour 0) | 1x | 6, breaks off | 0 | 17 to 25 ms |
| :10 | 4x | 6, breaks off | 0 | 26 to 34 ms |
| :10 | 1x | 4, breaks on | 0 | 17 to 25 ms |
| :45 | 1x | 6, breaks off | 0 | 17 to 25 ms |
| :45 | 4x | 12, breaks off | 2 (one of 76 ms, one of 82 ms) | 25 to 82 ms |

Before the fix, the same probe at :10 gave one gap of 100 to 133 ms in every run (1x and 4x, breaks on and off), and at :45 none in 16 runs. The two gaps at :45 under 4x slowdown are not the fix's doing: at :45 a truck is already on the road, so the warm-up never runs, and no WebGL program was linked during those drags; the machine was loaded (load average about 7). They are reported as measured. At `e76e345` the replacement moved to the first frame drawn after the trucks source loads; a probe at that commit (8 runs at a :10 departure, at 1x and 4x CPU) linked no WebGL program during the drag and showed one 68 ms gap, at 4x, with no compile behind it. Its runs are not in the table, and the probe is outside the repository. The real-GPU cost of the program compile is not measured. `measure-slider.mjs` takes `DEP_MINUTE` to pin the departure minute; measure at both a minute under 30 and one over 30, because the two open the slider differently.

**Limits.**
- **GPU and scope.** The browser drew with software WebGL, so a real phone and a real GPU are unmeasured, including the cost of the program compile that the fix moves. The first paint of the map and the time to draw a plan were not measured, and the grid sizes come from the stand-in's cell-size setting and were not recounted.
- **What each table measured.**
  - The 12-drag table is the run at `de0ce4b`: four configurations, 3 drags each, with the departure minute not pinned. It predates the rest-break and stop-weather screens, and its "0 frames over 50 ms" depended on the minute it ran at, as the cause below shows. An earlier run of the same script on a different Chromium build had seen one or two isolated frames of 50 to 133 ms per drag; that was the same cause, not a browser difference.
  - The "before the fix" figures (a gap of 100 to 133 ms at :10, none at :45) are the same probe on the controller of `d3b41e6`, with the other changes of the working tree around it.
  - The after-fix table is the probe on the tree committed as `21148f5`, which holds the fix. It is one drag per run, with no warm-up pass, at 1x and 4x CPU slowdown, and not the four-configuration, 12-drag run: it has not been repeated at 267 and 520 grid cells.
- **Only the trucks program.** The fix removes the trucks layer's program from the drag, and the measurement no longer depends on the departure minute for that program only. In 3 of about 26 loaded runs a program for a line layer linked mid-drag instead, a late first compile of another layer; it is not covered by the fix and has not been traced.
- **Noise.** Under the 4x slowdown at :45, two of 12 drags showed one 76 to 82 ms gap with no program built during the drag, on a loaded machine. They are reported, not explained.

## Build size

Sizes of the frontend build at commit `57091ed`, built from a `git archive` of that commit and reported by Vite (the worker's gzip size is `gzip -c`, because the build prints no figure for it):

| File | Size | Gzip |
|---|---|---|
| Entry `index-*.js` | 659.19 kB | 206.31 kB |
| Map chunk `MapView-*.js` | 1,089.37 kB | 296.76 kB |
| Worker `maplibre-gl-worker-*.mjs` | 520.11 kB | 147,800 bytes (about 144.3 KiB) |
| `MapView-*.css` | 71.33 kB | 10.25 kB |
| `index.html` | 0.54 kB | 0.38 kB |

At `de0ce4b`, the build the slider drag above was measured on, the entry was 641.53 kB (201.71 kB gzip) and the map chunk 1,087.20 kB (296.18 kB gzip); the worker and the stylesheet were the same files. The entry has grown by about 4.6 kB gzip since.

The entry loads first and renders the trip form; the map chunk and its worker load after it, so the form does not wait for MapLibre. Vite warns that the entry, the map chunk and the worker are larger than 500 kB after minification. The image's served build is about 2.3 MB uncompressed, read into memory at start-up ([architecture.md](architecture.md#hosting)).
