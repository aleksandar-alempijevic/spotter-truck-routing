# Performance

What was measured, where and on which build, and what was not measured. Every figure comes from a recorded run. Local runs were made on a laptop between 2026-11-12 and 2026-11-14; the [Hosted](#hosted-render-free-plan-2026-11-14) section is the deployed app on 2026-11-14. The scripts behind the local runs are in the repository, except the WebGL program-link probe and the traces behind the slow-frame diagnosis.

## Planning a trip

Planning is two requests: routes first, so they reach the map before the weather finishes, then weather risk. The scripts below spend live provider quota, so they are outside `make check` ([README](../README.md#tests-and-checks) lists them).

### Routes

`backend/live_check.py` ran the routes endpoint over seven trips with the real TomTom, at 25-mile spacing, on 2026-11-12. These runs predate two changes: routes were not yet limited to the US, and TomTom was sent the entered load (80,000 lb) rather than the cargo plus the 33,000 lb rig. The script now sends 47,000 lb of cargo.

| Trip | Routes | Latency | Response | TomTom calls |
|---|---|---|---|---|
| Los Angeles to New York | 3 (2 from TomTom, 1 via Albuquerque) | 14.7 s | 145 kB | 3 |
| Seattle to Miami | 3 | 12.0 s | 181 kB | 1 |
| Chicago to Los Angeles | 3 | 8.8 s | 100 kB | 6 |
| Dallas to San Francisco | 3 | 8.4 s | 106 kB | 1 |
| Denver to Atlanta | 3 | 4.1 s | 73 kB | 1 |
| Chicago to Indianapolis | 3 | 1.9 s | 12 kB | 1 |
| Dallas to Houston | 3 | 1.6 s | 12 kB | 1 |

Lines carry 100 to 2,100 points after reduction. These are one-off measurements: TomTom's latency on long trips varies a lot between identical calls.

### Weather

`backend/live_weather_report_check.py` routed Seattle to Miami (the trip with the most locations) at 25-mile spacing with one TomTom call (423 checkpoints) and sent the routes to the weather endpoint, on 2026-11-13, before the same two routing changes as above. The cold request needed 515 Open-Meteo locations (379 checkpoint cells and 136 cells only the heatmap needs; the grid has 436 display cells) in 4 chunks, finished in 1.05 s with no wait and returned 166 kB. The repeat fetched nothing and returned the same body in 0.12 s, because the forecast cache is shared by every request.

A cold request that needs at most 600 locations on a fresh minute window needs no wait. 10-mile spacing on a long trip needed 676 to 1,051 locations in the measurements, so it waits for the window once ([assumptions.md](assumptions.md#quota-and-cache)). `backend/live_weather_check.py` measures Open-Meteo's quota behaviour.

With rest breaks on, stops add forecast locations. The additions come from synthetic routes, not a live trip: a stop adds a location only when its cell is new, which on a long trip is about one per stop at 25 and 50-mile spacing (up to about 25 more) and about half that at 10 miles.

### Address search

`backend/live_address_check.py` ran 8 typed queries through the endpoint against Geoapify on 2026-11-12: all answered with HTTP 200 in 0.66 to 2.79 s.

## The map and the slider

### Method

A scripted pointer drag of the slider across every hour and back (`frontend/scripts/measure-slider.mjs`), in headless Chromium (Chrome for Testing 153.0.8010.12) at 390 by 844 with touch emulation, with software WebGL. The app was a production build served by `vite preview` and fed by a typed stand-in API, so no provider was called. `DEP_MINUTE` pins the departure minute; measure at a minute under 30 and one over 30, because the two open the slider differently (below).

### Results

The slider recolours only the heatmap cells whose level changed and makes no request. On a 2026-11-13 build, before the rest-break screens and the fix below, 12 drags (267 and 520 grid cells, with and without a 4x CPU slowdown) showed no long task over 50 ms, no `pointermove` event over 16 ms, no request during the drag, and a median frame gap of 16.7 ms.

On the build with the fix (2026-11-14), one drag per run, no warm-up pass:

| Departure | CPU | Runs | Frames over 50 ms | Largest gap |
|---|---|---|---|---|
| :10 (slider opens at hour 0) | 1x | 6, breaks off | 0 | 17 to 25 ms |
| :10 | 4x | 6, breaks off | 0 | 26 to 34 ms |
| :10 | 1x | 4, breaks on | 0 | 17 to 25 ms |
| :45 | 1x | 6, breaks off | 0 | 17 to 25 ms |
| :45 | 4x | 12, breaks off | 2 (one of 76 ms, one of 82 ms) | 25 to 82 ms |

The fix was then tightened to end at the first frame drawn after the trucks source loads (the current code). A probe of that build, 8 runs at a :10 departure at 1x and 4x CPU, linked no WebGL program during the drag and showed one 68 ms gap, at 4x, with no compile behind it.

The two gaps at :45 under 4x are not the fix's doing: at :45 a truck is already on the road, so the warm-up never runs, no WebGL program was linked during those drags, and the machine was loaded (load average about 7). Their cause has not been traced.

### The slow frame: cause and fix

Without the fix, each drag that started at hour 0 showed one isolated frame of 100 to 217 ms, with rest breaks on or off alike. A trace found the cause in the app: the first time the map draws a moving truck, MapLibre compiles a WebGL program for the trucks circle layer (a constant colour with a per-feature radius that no other layer uses), and under headless software GL that compile blocks the GPU process for about 117 ms. The layer is empty while the slider sits at hour 0, because no truck is driving yet (`truckPoints`). The slider opens at hour 0 only for a departure under 30 minutes past the hour (`initialHour` in `timeline/grid.ts`), so the first draw landed on the first step of the drag, and whether a run saw the slow frame depended on the minute it was made.

The fix: when the slider first has no truck to show, the controller draws one truck at the first route's start, under the endpoint marks, so the program is built when the plan appears; the first frame drawn after the trucks source loads replaces it with what the hour says (`warmTrucks` in `map/controller.ts`, `warmupTruck` in `map/features.ts`). It does nothing when a truck is already on the road, so a departure at :45 is unchanged.

### Limits

- **Software graphics only.** The browser drew with software WebGL, so a real phone and a real GPU are not measured, including the real cost of the program compile that the fix moves.
- **Not measured:** the first paint of the map and the time to draw a plan. The grid sizes come from the stand-in's cell-size setting and were not recounted.
- **Only the trucks program.** The fix moves only the trucks layer's compile out of the drag. In 3 of about 26 loaded runs a program for a line layer linked mid-drag instead; it is not covered by the fix and has not been traced.
- **Coverage of the after-fix runs.** They are one drag per run and have not been repeated at 267 and 520 grid cells.

## Hosted (Render free plan, 2026-11-14)

All figures here are from the hosted service on 2026-11-14, one run each through the page, with the live providers and on the code deployed that day (before the US-only routing and the gross weight). They show what a trip costs on the small free instance; they are not a distribution.

| Trip | Routes | Weather | Forecast locations | Results on screen |
|---|---|---|---|---|
| Dallas to Houston, short | 2.38 s | 0.96 s | not recorded | not recorded |
| Seattle to Miami, 25 mi | 16.03 s | 3.27 s | 517 | 19.7 s after the click |
| Los Angeles to Miami, 10 mi | 13.61 s | 26.07 s | 926, with one minute-window wait completed through the edge | 40.5 s after the click |
| Dallas to Seattle, rest breaks on | 10.88 s | 1.96 s | 410 | not recorded |

- **Planning waits.** Warm routes took 2.4 to 16.0 s, so the wake copy on the routes wait appears only after 20 s. The wait across a rate-limit minute window completed through the edge.
- **Rest breaks.** The Dallas to Seattle trip, the one trip run with breaks on against TomTom, had 17 stops, each with its weather, and its stop marks and their key showed on the map. The rule is otherwise tested on synthetic and mocked routes.
- **Address search.** Warm large-city searches took up to 7.1 s ("New York, NY" 6.66 s, "Boston, MA" 7.11 s), and other city searches 1.0 to 4.45 s, so the address wake copy waits 10 s.
- **Idle wake.** After 16 min 32 s with no requests, an address search got its 200 JSON answer after 13.2 s, with the edge holding the request and no gateway page. That the instance slept is inferred from the timing.
- **Long requests.** Responses held for 100, 130 and 160 s arrived intact through the edge, and origin 502, 503 and 504 answers kept the API's JSON body, so the routes and weather deadlines fit.
- **Compression and caching.** The edge compresses: the entry is 203,813 B and the map chunk 292,291 B as gzip, the API answers with brotli, and a weather answer was 164,882 B uncompressed and 7,463 B with brotli. Hashed assets are served `immutable` and the page is never cached, but assets are not cached at the edge (`DYNAMIC`).
- **Slider.** One drag per rate on the first deployed build, at phone size, with a departure at :11: no frame over 50 ms at 1x or 4x slowdown, and the largest gap 41.8 ms at 1x and 23.8 ms at 4x. That is a single drag at each rate, still with software rendering in the measuring browser.
- **Open-Meteo.** No 503 in the runs, at one time of day only.

## Build size

Sizes of the frontend build of 2026-11-14 (the build just before the first deploy), reported by Vite; the worker's gzip size is `gzip -c`, because the build prints no figure for it. The frontend has changed since (wait-copy timings, the keyboard layout hold, error copy), and the sizes have not been re-measured.

| File | Size | Gzip |
|---|---|---|
| Entry `index-*.js` | 659.19 kB | 206.31 kB |
| Map chunk `MapView-*.js` | 1,089.37 kB | 296.76 kB |
| Worker `maplibre-gl-worker-*.mjs` | 520.11 kB | 147,800 bytes (about 144.3 KiB) |
| `MapView-*.css` | 71.33 kB | 10.25 kB |
| `index.html` | 0.54 kB | 0.38 kB |

The entry loads first and renders the trip form; the map chunk and its worker load after it, so the form does not wait for MapLibre. Vite warns that the entry, the map chunk and the worker are larger than 500 kB after minification. The image's served build is about 2.3 MB uncompressed, read into memory at start-up ([architecture.md](architecture.md#image-and-serving)).
