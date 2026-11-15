# Architecture

Two programs that talk over HTTP, in one repository: a Django API in `backend/` and a React app in `frontend/`. In development Vite serves the app and forwards `/api` to Django (`vite.config.ts`); deployed, one container serves both from one origin ([hosting.md](hosting.md)). Either way the browser sees one origin and needs no CORS setup.

```
browser  ──►  Vite dev server (:5173)  ──/api──►  Django on uvicorn (:8000)
 React app     serves the app, proxies /api        Django Ninja endpoints
```

Planning a trip is two requests: routes first, then weather risk, so the routes appear on the map before the weather finishes loading. This page covers how routes, checkpoints and weather are computed and how the code is laid out. The endpoints, their validation and errors, and the provider-call policy are in [api.md](api.md); the risk and ranking rules are in [logic.md](logic.md); the readings and limits behind them are in [assumptions.md](assumptions.md).

## Backend layers

Django 6 with Django Ninja, served by uvicorn over ASGI so views can be `async`. There is no database; the settings declare none.

The code is split into packages, and imports run one way:

| Package | Imports from the app | Role |
|---|---|---|
| `risk_rules/` | nothing (standard library only) | The risk level at a checkpoint (`levels.py`), the route summary (`summary.py`) and the ranking (`ranking.py`) |
| `routing/` | nothing (standard library only) | Pure computation on a provider-neutral `Route`: checkpoints and ETAs, the rest-break rule, the overlap measure, via-city candidates, the assumed empty-rig weight (`vehicle.py`), line reduction for the map, route order and ids |
| `weather/` | `routing.geo` only | The hourly `ForecastSeries` and sampling at an instant, the 0.1° forecast lattice, the bounded `ForecastCache`, and the corridor grid with `plan_locations` |
| `providers/` | `routing`, and `weather` in `openmeteo.py` | The only package that imports `httpx`, knows a provider's URL and field names, or touches a key: the shared outbound policy and the TomTom, Geoapify and Open-Meteo adapters ([api.md](api.md#provider-calls)) |
| `api/` | `providers`, `weather`, `routing`, `risk_rules` | The endpoints (`api.py`), the wire schemas (`schemas.py`), the route planner (`planner.py`), the weather use case (`weather_report.py`), errors and middleware |

Tests enforce these boundaries: `risk_rules`, `routing` and `weather` import only the standard library and what the table lists, importing any of them loads no Django, and only `providers` imports `httpx`. The weather use case is the only caller of `risk_rules` and the only place a `WeatherReading` is built. A test feeds the planner's checkpoints into `risk_rules.summarize_route`, so the two packages' contract is checked without either importing the other.

**Settings.** `config/base.py` reads environment variables and refuses to start without a secret key unless debug is on. `config/settings.py` loads `.env` and then `base.py`; `config/settings_test.py` skips `.env` and uses dummy keys, so tests never touch real credentials or live APIs. `config/asgi.py` is the application object uvicorn serves, and `config/urls.py` mounts the API at `/api/`.

## Routes and checkpoints

### How routes are made

1. **TomTom first.** The planner (`api/planner.py`) asks TomTom for the fastest truck route and two alternatives, sending the gross weight ([assumptions.md](assumptions.md#trip-request)), the departure time with predicted traffic, a request to avoid border crossings and a request for country sections.
2. **US only.** `providers/tomtom.py` keeps a route only when every country section's code is in `US_COUNTRY_CODES`; the rule and what it assumes about TomTom's codes are in [assumptions.md](assumptions.md#routes-and-checkpoints). When TomTom returns routes and none is kept, the answer is a 422 `no_route`. Between Seattle and Anchorage TomTom's routes all pass through Canada (observed 2026-11-14), so a trip between the lower 48 and Alaska gets `no_route`. An origin in the open Atlantic is a TomTom 400 with the code `MAP_MATCHING_FAILURE`, also reported as `no_route` (observed again in the live run of 2026-11-15).
3. **Via-city fill.** When fewer than three routes are kept, the planner fills the gap through via cities: up to three cities on each side of the trip, chosen from a hand-kept list of 45 US hubs (`routing/via_cities.py`) as at least 120 km from every route already in hand, least detour first, the two sides alternating. Every candidate's call starts at once, and the outbound cap lets four run at a time. As each answer arrives it is kept only if it overlaps every route kept so far by less than half (`routing/overlap.py`). Once three routes are kept, the calls still running or waiting are cancelled, so a gap that fills early costs few calls, and a trip with no distinct third route costs at most six via calls plus the base call. Each call may be retried once after a timeout or a server error ([api.md](api.md#provider-calls)).
4. **Fewer than three.** When the fill finds no distinct route, or fails or runs out of time, the response carries the routes it has with a `shortfall` and its message. A failed fill never fails the request.

The overlap work and the parsing of TomTom's answers run in threads, so a long route's tens of thousands of points do not block the event loop, and each kept route's near-cells are computed once. Ids come from sorted order (travel time, then miles), so the same routes get the same ids whatever order TomTom returns them in.

### Checkpoints and ETAs

`routing/checkpoints.py` places the checkpoints and `routing/route.py` interpolates the times.

- **One distance scale per route.** A route's miles are TomTom's reported length, and polyline distances are scaled to it, so checkpoint positions and ETA knots agree (TomTom's own polyline length differs from it by up to 2.6 km on a long trip). Checkpoints are placed on the full-resolution line before it is reduced for the map.
- **Marks** start at mile 0, ascend strictly at the chosen spacing and end at the route's total miles, so the destination always has a checkpoint. A length that is an exact multiple of the spacing does not get its last mark twice.
- **ETAs** are interpolated between TomTom's turn instructions, which carry cumulative distance and time. A route whose instruction times go backwards, or whose last time differs from the travel time, is rejected as a malformed provider response, never interpolated around.

### Rest breaks

Rest breaks are off unless the request sets `rest_breaks`. With them off, `driving_seconds` equals `travel_time_seconds`, `stops` is empty and every ETA is driving time. With them on, one schedule per route, made by `routing.rest_breaks.plan_stops` from the route's driving time, produces all three outputs, so they cannot disagree:

- each checkpoint's ETA is the departure plus the driving time to its mark plus the stops taken before it;
- `travel_time_seconds` is driving time plus every stop;
- each entry of `stops` has a `kind` (`break`, `rest` or `restart`), the `mile`, `lat` and `lon` where the truck stands (found through `Route.meters_at`, the inverse of the time interpolation), its `starts_at` and its `duration_seconds`.

A trip with no more than 8 hours at the wheel has no stops in either mode, which is why the response echoes the mode as `breaks_applied`. Stops are a separate list: they never enter `checkpoints`, whose index is how the weather answer is joined to a route. `Route`'s knots and `travel_time_s` stay driving time. The flag is a field of `RoutesIn` only, so the weather request reads each checkpoint's ETA and each route's `travel_time_seconds` as given. The rule is in [logic.md](logic.md#4-rest-breaks-when-they-are-on) and its readings in [assumptions.md](assumptions.md#when-rest-breaks-are-on).

## Weather

The weather use case (`api/weather_report.py`) plans the forecast locations, fetches what the cache lacks from Open-Meteo, samples each checkpoint, stop and grid cell, and applies `risk_rules`. Its answer has, per route, the readings and levels at each checkpoint and stop, a summary from `summarize_route` (miles at each level, no-forecast miles, average risk), the ranking from `rank_routes` mirrored on the wire (`decided_by`, per-route `vs_first`), and the corridor grid. A one-route plan has one ranking entry, `decided_by` null and no `vs_first`, and is recommended unless it has No Travel miles ([logic.md](logic.md#3-ranking)).

### Sampling at a checkpoint

`conditions_at` in `weather/series.py` reads the series of the checkpoint's 0.1° forecast cell at the checkpoint's ETA. The sampling rules (which stamp each value comes from, the edges of the forecast, and why) are in [assumptions.md](assumptions.md#forecast-source-and-sampling).

- **Units.** Rain is precipitation less the water in the snow (snowfall divided by 7, Open-Meteo's fixed ratio); snow is the snowfall depth.
- **No forecast.** `weather` and `risk` are null together, and a null level means the forecast does not reach that time, never Low. The load is applied by `classify_weather`.
- **Gusts** are shown and never classified. Each reading carries `gust_warning`, true when the gust is at least `GUST_WARNING_MPH` in `risk_rules/levels.py`, which is the Severe wind edge (45 mph); the UI then shows a blow-over warning ([logic.md](logic.md#1-risk-level-at-one-checkpoint)).

### Weather at a stop

Each stop gets one reading, in the request's order, as `{mile, at, weather, risk}`, classified exactly as a checkpoint is. The stop is read at its start, at every top of the UTC hour inside it and at its end (`weather.instants_during`), and the highest level wins, the earliest instant on a tie; `at` is that instant. Why the worst reading, and why stops stay out of the summary and the ranking, is in [logic.md](logic.md#4-rest-breaks-when-they-are-on). An instant the forecast does not reach is left out, and a stop with none reached has `weather`, `risk` and `at` null.

A stop adds a forecast location only when its 0.1° cell is neither a checkpoint's nor one the grid reads (`LocationPlan.stop_only_cells`), and it never changes which forecast colours a heatmap cell. It counts toward the 1,800 limit. On three synthetic cross-country routes (about 44 to 50 hours at the wheel, 24 or 25 stops in all) stops added 12 and 15 locations at 10-mile spacing and 20 to 24 at 25 and 50 miles, on bases of 387 to 948.

### Corridor grid

`weather/grid.py` builds the heatmap: a risk level, with the load rules applied, for each cell and each hour from 0 to 48.

- **Cells** are 0.5° (`cell_degrees`; about 35 by 27 miles in the US), sent as centres with one shared size, and a cell's index is its id. A cell is in the corridor when its centre is within 25 miles of the segments joining a route's consecutive checkpoints.
- **Hours.** Hour 0 is the top of the request's UTC hour (`grid.start`); the departure is a separate field. Hours are sampled by position in the series: a cached series starts at the request's hour, so grid hour h is its entry h (`conditions_by_hour`; a series that starts at another hour is shifted by the difference).
- **Levels** are indexes into `level_codes`, so the browser recolours a cell from the array with no further request.
- **Shared locations.** A display cell that holds a checkpoint's forecast cell reads that forecast, so only cells with no checkpoint add a location. Three cross-country routes at 25-mile spacing need about 520 locations for 436 cells ([measured](performance.md#weather)).
- **Edges of the map.** Corridor cells whose centre would lie past a pole or the antimeridian (judged on the unclamped centre) are left out, so no request point is off the map; a checkpoint's own cell is not adjusted, because the service box keeps checkpoints far from both. The sweep covers each segment's bounding box, which validation keeps to road length.

### Quota, waiting and deadline

- **Quota.** Open-Meteo bills one call per location and limits locations per IP ([assumptions.md](assumptions.md#quota-and-cache)). The adapter owns the minute limit (`RATE_LIMIT_WINDOW_S`, `LOCATIONS_PER_WINDOW` in `providers/openmeteo.py`); the use case derives its largest wait (one window plus a small pad) and its location bound (three windows) from them, so a paid key changes the adapter and a setting only. Locations are fetched in chunks of at most 150 as form posts, under the shared cap of 4 calls in flight, checkpoint cells first.
- **Waiting.** The use case owns the wait; the adapter exposes its call and its parsing separately (`request_forecasts` hands opaque raw answers to `parse_forecasts`). A refused chunk (429) is retried after its `Retry-After` plus a second when the delay is given, is at most a window plus a small pad (62 s), and still fits before the deadline; the fit is checked before sleeping, and the sleep happens after the call has released its outbound slot. A chunk is retried after each of its first three refusals; a fourth is a 503. Every other refusal is a 503 `provider_limited` at once: a 401 or 403 (credentials), a missing delay, a long one (an hourly or daily limit), or a wait that would not fit. There is no partial result: a request is complete or an error.
- **Deadline.** One 150 s deadline covers the request's provider work, enough for two full waits and the calls; passing it is a 504 `provider_timeout`. Each Open-Meteo call has a 12 s read timeout (a chunk takes about half a second) and one retry on a timeout or 5xx.
- **Connect tries.** The suspected cause of the host's connection failures is that Open-Meteo drops connection attempts from the host's shared outbound address; the evidence is one hosted log line, a connect timeout after 20 s, on 2026-11-15 ([hosting.md](hosting.md#logs)). So an Open-Meteo connect is tried up to 4 times at 3 s each (`CONNECT` in `providers/openmeteo.py`). A refused connection or a failed name lookup waits 0.25 s, 0.5 s and 0.5 s before the next try; a connect timeout waits for nothing. A call that never connects is not retried again, so the connect tries and the retry do not multiply.
- **Worst cases.** 12 s for a call that never connects (4 connect timeouts of 3 s; up to 13.25 s with refusals and their pauses mixed in), 24 s for two read timeouts after connecting at once, and 48 s (about 50 s with pauses) for two read timeouts each preceded by 3 failed connects.
- **Status.** Two read timeouts are a 504. A call that never connects ends with its last try's error: a connect timeout is a 504, a refused connection (`ConnectError`) a 502. Other upstream failures and malformed answers are a 502.

### Cache

The forecast cache (`weather/cache.py`) holds series by forecast cell and is used only while the series' first stamp is the request's current UTC hour.

- **One per process.** It is part of the use case's `Runtime` (the clock, sleep, deadline clock, cache and limits), which tests replace as one object; the process keeps one (`WEATHER_RUNTIME` in `api/api.py`), so every request shares the cache. That needs one server process.
- **Bounded and on the event loop.** It holds at most 3,000 cells (about 38 MB: 1,000 series of 96 hours measured 12.6 MB) and is touched only on the event loop. Each chunk is parsed and stored as it arrives.
- **Retries fetch only what is missing.** When one chunk fails, the others' unfinished calls are cancelled, but a chunk whose response has already arrived is still parsed and stored (in its own task, shielded from the cancellation), so a retry after a 503, 504 or 502 fetches only what is missing.
- **One clock read.** A request that waits across the hour keeps what it holds and never re-reads the cache, which accepts a one-hour approximation at grid hour 0 for late chunks. Concurrent cold requests for the same cells both fetch.

Open-Meteo's free tier is non-commercial and requires CC BY attribution; the response carries `attribution: {text, url}` for the UI to show.

## Frontend

React 19, TypeScript, Vite and Material UI. TanStack Query owns all server requests. The API's types are generated, not written by hand: `src/api/schema.d.ts` comes from the backend's OpenAPI schema (`make types`), and `make check` regenerates it and fails if the committed file differs. `openapi-typescript` declares TypeScript 5 as its peer; `pnpm.peerDependencyRules` in `package.json` allows 6, and the drift check would catch a generator that stopped working.

The app has one page, and the code under `src` is split by what it owns:

- `api/` is the typed `fetch` client and its three endpoint calls; its `ApiError` carries the error `code`, and everything that branches on a failure branches on that code.
- `form/` is the trip form: address search (debounced, city-first, with an "add the city" hint for number-first text), the departure (now, or a time read in the origin's zone), the load in pounds (empty at the start), the spacing and the rest-break switch (off at the start, with a line saying what it adds and that it assumes a rested start). Changing the switch or the spacing is a new plan: routes are requested again and no selection carries over.
- `plan/` is pure logic with no React: the request bodies, the view of a plan the screens read, the "Why this route?" explanation (first place only, ties marked), the gust-warning lines (`describe.ts`), and `errors.ts`, one message and one action for every error code in each of three contexts (routes, weather, address). The table is typed over the generated code union, so a code added on the backend fails `tsc` until it has a row. `queries.ts` holds the two planning queries, each made once per submission and never retried or refetched on its own; the global default in `plan/queryClient.ts` is also no retry.
- `panel/` is the route cards, the route chips on a phone, the "Why this route?" expand, the checkpoint list (with required stops as rows of their own between the checkpoints they fall between, interleaved at render so no checkpoint index moves), the named wait stages, the error notices and the credits. The gust warning (`GustWarning.tsx`, a wind glyph in an accent colour no risk level uses) shows on a checkpoint or stop row, on the route card with the highest gust on the route, and on a phone as "Gust N mph" on the route's chip, with the full line under the chip row for the selected route.
- `risk/` owns the five levels' glyphs and colours, so the map, the lists and the key draw one set; `time/` formats times in a named zone.
- `timeline/` is the 0 to 48 hour slider (marks, plus and minus one hour, tap on the track) and the truck positions derived from the checkpoint ETAs and the stops, so a truck stands still for a stop's whole duration.
- `layout/` decides the layout from the viewport (`useLayoutMode`): a bottom sheet with peek, half and full states below 600 px wide on a tall screen; a side pane from 600 px wide or on a short screen; and from 1700 px the pane with two columns. While a text field is focused the sheet holds by width alone, so a phone keyboard opening never swaps the layout. A tapped spot reads in the sheet on a phone and in a map popup elsewhere, with the gust warning when there is one. It also holds the error boundary around the map and the focus management, and it makes the map inert behind the phone form.
- `map/` is the one place that imports MapLibre, on the OpenFreeMap Positron basemap (a plain background replaces it if it cannot load; switching is described in [hosting.md](hosting.md#hosting-choices)). The page loads it as a separate chunk with its worker, after the form has rendered; ESLint allows only a dynamic `import()` of it, or a type-only import. The routes, checkpoints (a glyph per level, so the level never depends on colour alone), the corridor heatmap and the selected route's stops (an octagon with a pause sign) are GPU layers fed from the plan, not React elements. The slider drives the heatmap by recolouring only the cells whose level changed, with no request. The controller recovers from a lost WebGL context.

The slider's drag performance and the build sizes are measured in [performance.md](performance.md).

## What the tests cover

The commands are in the [README](../README.md#tests-and-checks). pytest covers the endpoints with their providers mocked, the layering and key-leak checks, the settings guard, the risk rules, the weather validator fed real routes responses at all three spacings, a check that every installed middleware is async-capable, and a check that `/api/docs` references no file on this server. vitest covers the logic under `plan/`, `timeline/` and `map/`, and component tests for the key states.
