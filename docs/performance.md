# Performance

What was measured, where and on which build, and what was not measured. Every figure comes from a recorded run, and each section names the commit and date it was measured on. The [Hosted](#hosted-render-free-plan-2026-11-14) section is the deployed app; everything else ran on a laptop. The scripts behind the local runs are in the repository, except the WebGL program-link probe and the traces behind the slow-frame diagnosis.

## Planning a trip

Planning is two requests: routes first, so they reach the map before the weather finishes, then weather risk. The scripts below spend live provider quota, so they are outside `make check` ([README](../README.md#tests-and-checks) lists them).

**Measured on:** `6e223ad`, 2026-11-15, locally, with the real providers and 47,000 lb of cargo.

### Routes

`backend/live_check.py` ran the routes endpoint over seven trips at 25-mile spacing, plus one unroutable probe. It made 13 TomTom calls.

| Trip | Routes | Latency | Response | TomTom calls |
|---|---|---|---|---|
| Los Angeles to New York | 3 | 9.2 s | 141 kB | 1 |
| Seattle to Miami | 3 | 11.9 s | 182 kB | 1 |
| Chicago to Los Angeles | 3 | 6.6 s | 103 kB | 1 |
| Dallas to San Francisco | 3 | 8.1 s | 91 kB | 1 |
| Denver to Atlanta | 3 (2 from TomTom, 1 via Dallas) | 7.1 s | 71 kB | 6 (2 cancelled once the third route was kept) |
| Chicago to Indianapolis | 3 | 1.8 s | 12 kB | 1 |
| Dallas to Houston | 3 | 2.0 s | 14 kB | 1 |
| Open Atlantic to Los Angeles (unroutable) | 422 `no_route` | 0.2 s | — | 1 (TomTom 400 `MAP_MATCHING_FAILURE`) |

Lines carry 104 to 2,057 points after reduction, and every route's last ETA matched its travel time. These are one-off measurements: TomTom's latency on long trips varies a lot between identical calls.

### Weather

`backend/live_weather_report_check.py` routed Seattle to Miami (the trip with the most locations) at 25-mile spacing with one TomTom call (423 checkpoints) and sent the routes to the weather endpoint. The cold request needed 518 Open-Meteo locations (380 checkpoint cells and 138 cells only the heatmap needs; the grid has 436 display cells) in 4 chunks, finished in 0.83 s with no wait and returned 176 kB. The repeat fetched nothing and returned the same body in 0.09 s, because the forecast cache is shared by every request.

A cold request that needs at most 600 locations on a fresh minute window needs no wait. 10-mile spacing on a long trip needed 676 to 1,051 locations in earlier measurements (2026-11-13), so it waits for the window once ([assumptions.md](assumptions.md#quota-and-cache)). `backend/live_weather_check.py` measures Open-Meteo's quota behaviour.

With rest breaks on, stops add forecast locations. The additions come from synthetic routes, not a live trip: a stop adds a location only when its cell is new, which on a long trip is about one per stop at 25 and 50-mile spacing (up to about 25 more) and about half that at 10 miles.

### Address search

`backend/live_address_check.py` ran 8 typed queries through the endpoint against Geoapify, with 9 Geoapify calls: all answered with HTTP 200 in 0.47 to 3.71 s.

## The map and the slider

### Method

A scripted pointer drag of the slider across every hour and back (`frontend/scripts/measure-slider.mjs`), in headless Chromium (Chrome for Testing 153.0.8010.12) at 390 by 844 with touch emulation, with software WebGL. The app was a production build served by `vite preview` and fed by a typed stand-in API, so no provider was called. `DEP_MINUTE` pins the departure minute; measure at a minute under 30 and one over 30, because the two open the slider differently ([below](#the-slow-frame-cause-and-fix)).

### Results

| Run | Measured on | What it showed |
|---|---|---|
| 12 drags: 267 and 520 grid cells, with and without a 4x CPU slowdown, departure minute not pinned | `de0ce4b`, 2026-11-13, before the rest-break screens | No long task over 50 ms, no `pointermove` event over 16 ms, no request during the drag; frame gap median 16.7 ms, 95th percentile 16.7 to 16.8 ms; no frame over 50 ms at the minute it ran |
| Program-link probe, without the fix | `d3b41e6`, 2026-11-14 | One gap of 100 to 133 ms at a :10 departure in every run (1x and 4x, breaks on and off); none at :45 in 16 runs |
| Program-link probe, with the fix (table below) | `21148f5`, 2026-11-14 | No frame over 50 ms except two gaps at :45 under 4x |
| Program-link probe, current fix: 8 runs at :10, 1x and 4x | `e76e345`, 2026-11-14 | No WebGL program linked during the drag; one 68 ms gap, at 4x, with no compile behind it |

With the fix (`21148f5`), one drag per run, no warm-up pass:

| Departure | CPU | Runs | Frames over 50 ms | Largest gap |
|---|---|---|---|---|
| :10 (slider opens at hour 0) | 1x | 6, breaks off | 0 | 17 to 25 ms |
| :10 | 4x | 6, breaks off | 0 | 26 to 34 ms |
| :10 | 1x | 4, breaks on | 0 | 17 to 25 ms |
| :45 | 1x | 6, breaks off | 0 | 17 to 25 ms |
| :45 | 4x | 12, breaks off | 2 (one of 76 ms, one of 82 ms) | 25 to 82 ms |

The slider recolours only the heatmap cells whose level changed and makes no request. The two gaps at :45 under 4x are not the trucks compile: at :45 a truck is already on the road, so the warm-up never runs, no WebGL program was linked during those drags, and the machine was loaded (load average about 7). Their cause, and that of the 68 ms gap, has not been traced.

### The slow frame: cause and fix

Without the fix, a drag that starts at hour 0 shows one isolated slow frame (100 to 217 ms across the runs), with rest breaks on or off alike. A trace found the cause in the app: the first time the map draws a moving truck, MapLibre compiles a WebGL program for the trucks circle layer (a constant colour with a per-feature radius that no other layer uses), and under headless software GL that compile blocks the GPU process for about 117 ms. The layer is empty while the slider sits at hour 0, because no truck is driving yet (`truckPoints`). The slider opens at hour 0 only for a departure under 30 minutes past the hour (`initialHour` in `timeline/grid.ts`), so the first draw lands on the first step of the drag, and whether a run sees the slow frame depends on the minute it is made.

The fix: when the slider first has no truck to show, the controller draws one truck at the first route's start, under the endpoint marks, so the program is built when the plan appears; the first frame drawn after the trucks source loads replaces it with what the hour says (`warmTrucks` in `map/controller.ts`, `warmupTruck` in `map/features.ts`). It does nothing when a truck is already on the road, so a departure at :45 is unchanged.

### Limits

- **Software graphics only.** The browser drew with software WebGL, so a real phone and a real GPU are not measured, including the real cost of the program compile that the fix moves.
- **Not measured:** the first paint of the map and the time to draw a plan. The grid sizes come from the stand-in's cell-size setting and were not recounted.
- **Only the trucks program.** The fix moves only the trucks layer's compile out of the drag. In 3 of about 26 loaded runs a program for a line layer linked mid-drag instead; it is not covered by the fix and has not been traced.
- **Coverage of the with-fix runs.** They are one drag per run and have not been repeated at 267 and 520 grid cells. The slider has not been re-measured on the current frontend, which adds the gust warning and the keyboard layout hold.

## Hosted (Render free plan, 2026-11-14)

**Measured on:** the deployed build `a1a102e`, 2026-11-14, one run each through the page, with the live providers. The "New York, NY" and "Boston, MA" searches ran on `f43a2ae`, and the long-request holds on a throwaway probe build, the same day. These builds predate the US-only routing, the gross weight sent to TomTom and the gust warning. The figures show what a trip costs on the small free instance; they are not a distribution.

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
- **Slider.** One drag per rate, at phone size, with a departure at :11: no frame over 50 ms at 1x or 4x slowdown, and the largest gap 41.8 ms at 1x and 23.8 ms at 4x. That is a single drag at each rate, still with software rendering in the measuring browser.
- **Open-Meteo.** No 503 in the runs, at one time of day only.

## Build size

**Measured on:** `6e223ad`, 2026-11-15, as reported by Vite in `make check`; the worker's gzip size is `gzip -c`, because the build prints no figure for it.

| File | Size | Gzip |
|---|---|---|
| Entry `index-*.js` | 661.70 kB | 207.12 kB |
| Map chunk `MapView-*.js` | 1,089.37 kB | 296.76 kB |
| Worker `maplibre-gl-worker-*.mjs` | 520.11 kB | 147,800 bytes (about 144.3 KiB) |
| `MapView-*.css` | 71.33 kB | 10.25 kB |
| `index.html` | 0.54 kB | 0.37 kB |

The entry loads first and renders the trip form; the map chunk and its worker load after it, so the form does not wait for MapLibre. Vite warns that chunks are larger than 500 kB after minification. The served build is about 2.3 MB uncompressed, read into memory at start-up ([hosting.md](hosting.md#image-and-serving)).
