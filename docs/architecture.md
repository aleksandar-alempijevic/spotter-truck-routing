# Architecture

Two programs that talk over HTTP, in one repository: a Django API in `backend/` and a React app in `frontend/`. In development Vite serves the app and forwards `/api` to Django (`vite.config.ts`); deployed, one container serves both from one origin ([Hosting](#hosting)). Either way the browser sees one origin and needs no CORS setup.

```
browser  ──►  Vite dev server (:5173)  ──/api──►  Django on uvicorn (:8000)
 React app     serves the app, proxies /api        Django Ninja endpoints
```

Planning a trip is two requests: routes first, then weather risk, so the routes appear on the map before the weather finishes loading. The risk and ranking rules are in [logic.md](logic.md); the readings and limits behind them are in [assumptions.md](assumptions.md).

## Backend layers

Django 6 with Django Ninja, served by uvicorn over ASGI so views can be `async`. There is no database; the settings declare none.

The code is split into packages, and imports run one way:

| Package | Imports from the app | Role |
|---|---|---|
| `risk_rules/` | nothing (standard library only) | The risk level at a checkpoint (`levels.py`), the route summary (`summary.py`) and the ranking (`ranking.py`) |
| `routing/` | nothing (standard library only) | Pure computation on a provider-neutral `Route`: checkpoints and ETAs, the rest-break rule, the overlap measure, via-city candidates, line reduction for the map, route order and ids |
| `weather/` | `routing.geo` only | The hourly `ForecastSeries` and sampling at an instant, the 0.1° forecast lattice, the bounded `ForecastCache`, and the corridor grid with `plan_locations` |
| `providers/` | `routing`, and `weather` in `openmeteo.py` | The only package that imports `httpx`, knows a provider's URL and field names, or touches a key: the shared outbound policy and the TomTom, Geoapify and Open-Meteo adapters |
| `api/` | `providers`, `weather`, `routing`, `risk_rules` | The endpoints (`api.py`), the wire schemas (`schemas.py`), the route planner (`planner.py`), the weather use case (`weather_report.py`), errors and middleware |

Tests enforce these boundaries: `risk_rules`, `routing` and `weather` import only the standard library and what the table lists, importing any of them loads no Django, and only `providers` imports `httpx`. The weather use case is the only caller of `risk_rules` and the only place a `WeatherReading` is built. A test feeds the planner's checkpoints into `risk_rules.summarize_route`, so the two packages' contract is checked without either importing the other.

**Settings.** `config/base.py` reads environment variables and refuses to start without a secret key unless debug is on. `config/settings.py` loads `.env` and then `base.py`; `config/settings_test.py` skips `.env` and uses dummy keys, so tests never touch real credentials or live APIs. `config/asgi.py` is the application object uvicorn serves, and `config/urls.py` mounts the API at `/api/`.

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Returns `{"status": "ok"}` |
| `POST /api/routes` | Up to three truck routes with checkpoints and ETAs ([Routes and checkpoints](#routes-and-checkpoints)) |
| `POST /api/weather` | The forecast, risk levels, summaries, ranking and corridor grid for those routes ([Weather](#weather)) |
| `GET /api/address-search?q=…` | US place suggestions ([Address search](#address-search)) |

### The routes request and response

`POST /api/routes` takes origin and destination coordinates, a departure instant, the load in pounds, the checkpoint spacing and an optional `rest_breaks` flag, false when omitted. The response has up to three routes, fastest first, with ids `route-1` to `route-3` numbered from that order. Each route has its travel time in seconds (`travel_time_seconds`, departure to arrival), its driving time (`driving_seconds`), its `stops`, its miles, checkpoints (`mile`, `lat`, `lon`, `eta`), its line for the map as `[lon, lat]` pairs, its `source` (`provider` or `via_city`) and its `via` city. A `shortfall` with a reason and a message says why there are fewer than three: `no_distinct_alternative`, or `fill_incomplete` when the search for another route failed or ran out of its time budget; the message names the cities that were tried. The response also echoes whether the ETAs include rest breaks (`breaks_applied`).

**Time budget.** Each TomTom call may take 50 s, and one planning request has one 120 s deadline covering the base call and the fill. When the budget runs out during the fill, the routes in hand are returned with the `fill_incomplete` shortfall; during the base call it is a 504.

### The weather request

`POST /api/weather` takes back a subset of the routes response: `load_lb`, `checkpoint_interval_miles`, and per route `id`, `travel_time_seconds`, `total_miles`, `checkpoints` and `stops` (not `line`, `source`, `via` or `driving_seconds`). With rest breaks on, the travel time and ETAs already include the stops. The corridor is derived from the checkpoint positions, so no route line travels back; three of the longest test routes (about 10,500 miles together) make about 1,050 checkpoints at 10-mile spacing, roughly 100 kB of JSON.

The schema classes `PlanParams` and `RouteCore` are that subset and own its input bounds. Beyond the trip limits in [assumptions.md](assumptions.md#trip-request), they allow at most 600 checkpoints per route, at most 100 stops per route (each at most 48 hours), a `travel_time_seconds` of at most 30 days, every `mile` and `total_miles` at most 30,000, and every checkpoint `eta` and stop `starts_at` a timezone-aware instant between 30 days before now and 48 hours plus 30 days after now (`DEPARTURE_HORIZON` and `STOP_HORIZON` in `api/schemas.py`). A past time is accepted and simply has no forecast, which lets a weather retry of a plan left open for hours pass. `RoutesIn` and `WeatherIn` both extend `PlanParams`, so the two requests share one definition of the plan fields; `WeatherIn` takes `routes: list[RouteCore]` (up to three), and the weather response echoes the plan as a nested `plan: PlanParams`. Extra fields in the body are ignored.

**Validation** runs before any outbound call and answers 422 `validation_error`, with two exceptions that have codes of their own:

- **`outside_service_area`:** a checkpoint or stop outside the service box (latitude 15 to 72, longitude -170 to -50; [assumptions.md](assumptions.md#service-area)).
- **`too_many_locations`:** a plan that needs more than 1,800 forecast locations (three Open-Meteo minute windows of 600, the most that fits the deadline). `plan_locations(max_locations=…)` raises when the total passes that number, and earlier, as a cheap path, when the checkpoint cells or the corridor's display cells alone do. It is raised as Ninja's own validation error, so it takes the ordinary 422 path.

The other rules: unique route ids; the first mark at 0, marks strictly ascending and not past `total_miles` (at least as strict as `summarize_route`, which a table test checks); each mark gap at most the interval; and consecutive checkpoints no farther apart in a straight line than their mark gap (plus 5% and a quarter mile) and no farther apart in longitude than that distance can cover at their latitude (`longitude_span_coverable` in `weather/grid.py`, which also rejects a short hop across the antimeridian that would span the whole map in the planar sweep). These last two keep a hand-built body from making the corridor walk a huge area. Stops are validated like checkpoints: past the route's end, out of time order, starting outside the planning window, of no length or of an unknown kind is a `validation_error`.

### Address search

`GET /api/address-search?q=…` returns US place suggestions from Geoapify's autocomplete with `filter=countrycode:us`.

- **City first.** Text with no digit is searched with `type=city` first, which keeps "Salt Lake" from answering with a town in New Mexico; if that finds nothing, one more search runs without a type, so a depot name stays findable. A failed first call is an error, with no second call. Text containing a digit keeps the untyped search, so a suggestion can be an address, a street or a city.
- **Input and output.** The text is trimmed and must be 3 to 100 characters, checked before any provider call (otherwise 422). The response is `{suggestions: [{label, lat, lon, timezone}], attribution: {text, url}}`: `label` is the full text with the state, `timezone` an IANA name for converting a typed departure time, and the attribution (`Powered by Geoapify`) is what the free plan requires the UI to show. A suggestion without a label, coordinates or time zone is dropped, and no match is an empty list, not an error.
- **Timing.** Each Geoapify call has a 10 s connect limit and a 10 s read limit and is not retried, so one call can take close to 20 s, and a city search followed by the untyped search can take longer than 20 s. A timeout is a 504 and a refused connection a 502. A search with a number first and no place named is slow (7 to 9 s measured), and no filter or type speeds it up. The wake copy waits 10 s for a search ([Hosting](#wake-copy)).
- **Key.** `GEOAPIFY_API_KEY`; a missing one is a 503 `provider_not_configured`.

### Errors

Every endpoint's errors have one body, `{code, message}`, where `code` is one of a closed set (`validation_error`, `not_found`, `method_not_allowed`, `internal_error`, `no_route`, `provider_timeout`, `provider_unavailable`, `provider_limited`, `provider_not_configured`, `provider_malformed_response`, `provider_error`, `outside_service_area`, `too_many_locations`) that a test ties to every error class, so the generated types carry it as a union.

| Status | When |
|---|---|
| 422 | Validation, including `outside_service_area` and `too_many_locations`; no route between the points (`no_route`) |
| 504 | A provider timeout |
| 502 | An upstream failure or a malformed answer |
| 503 | A provider rate limit or a missing key |
| 404, 405, 500 | Unknown path, wrong method, unexpected exception |

- **The code comes from the error's type,** set where it is raised (`SPECIFIC_VALIDATION_CODES` in `api/errors.py`), never from the message text. A new error status enters through `API_ERRORS` (`api/errors.py`) or a provider error class with a code in the closed set, never through `HttpError` or a framework default.
- **Every error the API's own routing and endpoints produce has this body.** A request body that is not JSON, or over Django's upload limit, is a 422 `validation_error`; an unexpected exception is a 500 `internal_error` whose detail goes to the log, never to the client. `api/middleware.py` judges the body, not the layer: any error status under `/api/` whose body is not a JSON object with exactly `code` and `message` (Django's 404 page, Ninja's plain-text 405, a `Http404` inside an endpoint) is replaced, and a 405 keeps its `Allow` header. The middleware's 500 plus a warning for any other shape is an alarm for a gap, not a mapping to rely on. Every operation declares the 404, 405, 422 and 500 responses.
- **Outside the guarantee:** Django's host check (a disallowed `Host`) and the hosting edge can answer in another shape, so a client treats an error without a parsable `{code, message}` as an unknown failure.
- **Messages carry no URL, key or provider text** and name no single provider.

### Provider calls

`providers/outbound.py` holds the policy every provider call follows:

- **One HTTP client per API request,** opened inside the request's coroutine and closed on every exit, including the cancellation Django's ASGI handler applies on a client disconnect.
- **At most 4 calls in flight** per request, the one concurrency cap.
- **One retry** on a timeout, a transport error or a 5xx, never on a 4xx. A call made with `retry=False`, as address search is, is made once.
- **Connect tries** follow a per-call `ConnectPolicy`: one 10 s connect per try unless the caller asks for more. Only Open-Meteo does ([Quota, waiting and deadline](#quota-waiting-and-deadline)).
- **Provider-neutral errors** with no URL, key or upstream body in them. Each error class carries its code and its HTTP status, and the API's error handler and declared error responses are read from the classes. A 429's error carries the provider's `Retry-After` as the number `retry_after_s`, never in its message; a 401 or 403 carries none.
- **GET and form POST.** Besides GET, `post_form` sends a form-encoded body under the same policy, because the weather request does not fit in a URL.

The adapters: `tomtom.py` is the TomTom truck-mode adapter, where kilograms exist; `geoapify.py` is the Geoapify autocomplete adapter; `openmeteo.py` is the Open-Meteo adapter, which needs no key, applies the 7:1 snow ratio, checks the unit strings and the hourly stamps (the first and last are parsed, the rest checked by shape), parses off the event loop, and keeps a null as absent. Geoapify and Open-Meteo each define `ATTRIBUTION_TEXT` and `ATTRIBUTION_URL`.

## Routes and checkpoints

### How routes are made

1. **TomTom first.** The planner (`api/planner.py`) asks TomTom for the fastest truck route and two alternatives, sending the gross weight ([assumptions.md](assumptions.md#trip-request)), the departure time with predicted traffic, a request to avoid border crossings and a request for country sections.
2. **US only.** TomTom treats the border-crossing avoidance as a preference, so `providers/tomtom.py` keeps a route only when it has country sections and every section's code is in `US_COUNTRY_CODES` (`USA`, `PRI`, `VIR`); a route with missing or unnamed sections is dropped. The `PRI` and `VIR` labels are assumed from the ISO codes, not observed. This applies to the provider's alternatives and to via-city routes. When TomTom returns routes and none is kept, the answer is a 422 `no_route`. Between Seattle and Anchorage TomTom's routes all pass through Canada (observed 2026-11-14), so a trip between the lower 48 and Alaska gets `no_route`. An origin in the open Atlantic is a TomTom 400 with the code `MAP_MATCHING_FAILURE`, also reported as `no_route`.
3. **Via-city fill.** When fewer than three routes are kept, the planner fills the gap through via cities: up to three cities on each side of the trip, chosen from a hand-kept list of 45 US hubs (`routing/via_cities.py`) as at least 120 km from every route already in hand, least detour first, the two sides alternating. Every candidate's call starts at once, and the outbound cap lets four run at a time. As each answer arrives it is kept only if it overlaps every route kept so far by less than half (`routing/overlap.py`). Once three routes are kept, the calls still running or waiting are cancelled, so a gap that fills early costs few calls, and a trip with no distinct third route costs at most six via calls plus the base call.
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

`weather/series.py` reads the series of the checkpoint's 0.1° forecast cell (about 7 miles) at the checkpoint's ETA, by timestamp:

- **Wind** is interpolated between the stamps either side.
- **Gust, rain and snow** come from the first stamp at or after the ETA, because each describes the hour before its stamp.
- **Edges.** An ETA up to an hour before the first stamp reads the first stamp; later than the last stamp (96 hours ahead) there is no forecast. A needed value that is absent also means no forecast.
- **Units.** Rain is precipitation less the water in the snow (snowfall divided by 7, Open-Meteo's fixed ratio); snow is the snowfall depth.
- **Gusts** are shown and never classified. Each reading carries `gust_warning`, true when the gust is at least `GUST_WARNING_MPH` (45 mph, the Severe wind edge, in `risk_rules/levels.py`); the UI then shows a blow-over warning ([logic.md](logic.md#1-risk-level-at-one-checkpoint)).

`weather` and `risk` are null together, and a null level means the forecast does not reach that time, never Low. The load is applied by `classify_weather`.

### Weather at a stop

Each stop gets one reading, in the request's order, as `{mile, at, weather, risk}`, classified exactly as a checkpoint is. The stop is read at its start, at every top of the UTC hour inside it and at its end (`weather.instants_during`), and the highest level wins, the earliest instant on a tie; `at` is that instant. Why the worst reading, and why stops stay out of the summary and the ranking, is in [logic.md](logic.md#4-rest-breaks-when-they-are-on). An instant the forecast does not reach is left out, and a stop with none reached has `weather`, `risk` and `at` null.

A stop adds a forecast location only when its 0.1° cell is neither a checkpoint's nor one the grid reads (`LocationPlan.stop_only_cells`), and it never changes which forecast colours a heatmap cell. It counts toward the 1,800 limit. On three synthetic cross-country routes (about 44 to 50 hours at the wheel, 24 or 25 stops in all) stops added 12 and 15 locations at 10-mile spacing and 20 to 24 at 25 and 50 miles, on bases of 387 to 948.

### Corridor grid

`weather/grid.py` builds the heatmap: a risk level, with the load rules applied, for each cell and each hour from 0 to 48.

- **Cells** are 0.5° (`cell_degrees`; about 35 by 27 miles in the US), sent as centres with one shared size, and a cell's index is its id. A cell is in the corridor when its centre is within 25 miles of the segments joining a route's consecutive checkpoints.
- **Hours.** Hour 0 is the top of the request's UTC hour (`grid.start`); the departure is a separate field. Hours are sampled by position in the series: a cached series starts at the request's hour, so grid hour h is its entry h (`conditions_by_hour`; a series that starts at another hour is shifted by the difference).
- **Levels** are indexes into `level_codes`, so the browser recolours a cell from the array with no further request.
- **Shared locations.** A display cell that holds a checkpoint's forecast cell reads that forecast, so only cells with no checkpoint add a location. The worst measured case, three cross-country routes at 25-mile spacing, is about 515 locations and 436 cells, a 166 kB response.
- **Edges of the map.** Corridor cells whose centre would lie past a pole or the antimeridian (judged on the unclamped centre) are left out, so no request point is off the map; a checkpoint's own cell is not adjusted, because the service box keeps checkpoints far from both. The sweep covers each segment's bounding box, which validation keeps to road length.

### Quota, waiting and deadline

- **Quota.** Open-Meteo bills one call per location and refuses past 600 locations a minute, 5,000 an hour and 10,000 a day, per IP. The adapter owns the minute limit (`RATE_LIMIT_WINDOW_S`, `LOCATIONS_PER_WINDOW` in `providers/openmeteo.py`); the use case derives its largest wait (one window plus a small pad) and its location bound (three windows) from them, so a paid key changes the adapter and a setting only. Locations are fetched in chunks of at most 150 as form posts, under the shared cap of 4 calls in flight, checkpoint cells first.
- **Waiting.** The use case owns the wait; the adapter exposes its call and its parsing separately (`request_forecasts` hands opaque raw answers to `parse_forecasts`). A refused chunk (429) is retried after its `Retry-After` plus a second when the delay is given, is at most a window plus a small pad (62 s), and still fits before the deadline; the fit is checked before sleeping, and the sleep happens after the call has released its outbound slot. A chunk is retried after each of its first three refusals; a fourth is a 503. Every other refusal is a 503 `provider_limited` at once: a 401 or 403 (credentials), a missing delay, a long one (an hourly or daily limit), or a wait that would not fit. There is no partial result: a request is complete or an error.
- **Deadline.** One 150 s deadline covers the request's provider work, enough for two full waits and the calls; passing it is a 504 `provider_timeout`. Each Open-Meteo call has a 12 s read timeout (a chunk takes about half a second) and one retry on a timeout or 5xx.
- **Connect tries.** The suspected cause of the host's connection failures is that Open-Meteo drops connection attempts from the host's shared outbound address; the evidence is one hosted log line, a connect timeout after 20 s, on 2026-11-15. So an Open-Meteo connect is tried up to 4 times at 3 s each (`CONNECT` in `providers/openmeteo.py`). A refused connection or a failed name lookup waits 0.25 s, 0.5 s and 0.5 s before the next try; a connect timeout waits for nothing. A call that never connects is not retried again, so the connect tries and the retry do not multiply.
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
- `plan/` is pure logic with no React: the request bodies, the view of a plan the screens read, the "Why this route?" explanation (first place only, ties marked), and `errors.ts`, one message and one action for every error code in each of three contexts (routes, weather, address). The table is typed over the generated code union, so a code added on the backend fails `tsc` until it has a row. `queries.ts` holds the two planning queries, each made once per submission and never retried or refetched on its own; the global default in `plan/queryClient.ts` is also no retry.
- `panel/` is the route cards, the "Why this route?" expand, the checkpoint list (with required stops as rows of their own between the checkpoints they fall between, interleaved at render so no checkpoint index moves), the named wait stages, the error notices and the credits.
- `risk/` owns the five levels' glyphs and colours, so the map, the lists and the key draw one set; `time/` formats times in a named zone.
- `timeline/` is the 0 to 48 hour slider (marks, plus and minus one hour, tap on the track) and the truck positions derived from the checkpoint ETAs and the stops, so a truck stands still for a stop's whole duration.
- `layout/` decides the layout from the viewport (`useLayoutMode`): a bottom sheet with peek, half and full states below 600 px wide on a tall screen; a side pane from 600 px wide or on a short screen; and from 1700 px the pane with two columns. While a text field is focused the sheet holds by width alone, so a phone keyboard opening never swaps the layout. A tapped spot reads in the sheet on a phone and in a map popup elsewhere. It also holds the error boundary around the map and the focus management, and it makes the map inert behind the phone form.
- `map/` is the one place that imports MapLibre, on the OpenFreeMap Positron basemap (a plain background replaces it if it cannot load; [Basemap](#basemap)). The page loads it as a separate chunk with its worker, after the form has rendered; ESLint allows only a dynamic `import()` of it, or a type-only import. The routes, checkpoints (a glyph per level, so the level never depends on colour alone), the corridor heatmap and the selected route's stops (an octagon with a pause sign) are GPU layers fed from the plan, not React elements. The slider drives the heatmap by recolouring only the cells whose level changed, with no request. The controller recovers from a lost WebGL context.

The slider's drag performance and the build sizes are measured in [performance.md](performance.md).

**Quality gates.** `make test` runs pytest (the endpoints with their providers mocked, the layering and key-leak checks, the settings guard, the risk rules, the weather validator fed real routes responses at all three spacings, a check that every installed middleware is async-capable, and a check that `/api/docs` references no file on this server) and vitest (the logic under `plan/`, `timeline/` and `map/`, and component tests for the key states). `make check` adds the generated-types drift check, ruff lint and format checks on the backend, `tsc`, ESLint and Prettier checks on the frontend, and a production build, the only check that sees the map's worker file and its separate chunk.

## Hosting

The live app is <https://spotter-truck-routing-kxsl.onrender.com>, on Render's free plan. One container serves the built frontend and the API from the same origin, and the app calls `/api/...` on whatever host it was loaded from.

```
browser ──► host's HTTPS edge ──► container: uvicorn (one process)
                                    StaticBuild  ──►  /  and  /assets/*   the built frontend
                                    Django       ──►  /api/*              Ninja, `{code, message}` errors
```

### Image and serving

- **`Dockerfile`** builds in two stages: Node builds `frontend/dist` (pnpm as pinned in `package.json`), then a Python 3.13 image installs the backend's locked, non-dev dependencies and copies in only the backend packages and the build (no tests, live-check scripts, spikes or docs). It runs as a non-root user. The only build arguments are two non-secret frontend values, `VITE_HOST_SLEEPS` and `VITE_BASEMAP_STYLE`; empty or unset means the default, so a plain `docker build` makes the same app as a local build. The base images (`node:22-slim`, `python:3.13-slim` and the `uv` image) are pinned by digest, each beside its tag. The image measured 430 MB uncompressed as `docker images` reports it, and about 89 MB as a gzip of `docker save`.
- **`.dockerignore`** keeps every `.env` out of the build context, so a `COPY` cannot bake one in. The provider keys and the Django secret reach the container only as run-time environment values.
- **One origin, fixed paths.** `config/static.py` wraps the Django application in `config/asgi.py`. It answers `/` (`index.html`, `no-cache`, so a redeploy never leaves a browser on an entry that points at deleted chunks) and `/assets/*` (hashed files, cacheable for a year; `.js` and `.mjs` are served as `text/javascript`, which the map's module worker needs). Everything else, including every `/api/` path and the ASGI lifespan, goes to Django untouched. The app has one page and no client-side router, so there is no catch-all route. The API is mounted at `/api/` with no prefix, so the error middleware's `request.path` check holds as deployed. The build is read into memory at start-up (about 2.3 MB), so a request cannot name a file that was not in it.
- **A wrapper, not a middleware.** WhiteNoise's Django middleware (6.12) is synchronous only, and a sync-only middleware makes Django run every API request through a thread, while the forecast cache is only safe on the event loop.
- **One process.** The start command runs one uvicorn worker. The forecast cache and the weather runtime are per process, so a second worker would split them.
- **Proxy trust has one owner.** `DJANGO_TRUST_PROXY_SSL=1` (set in the image) makes Django read `X-Forwarded-Proto`; uvicorn's own forwarded-header handling is off (`--no-proxy-headers`). With no cookies, sessions or redirects the only effect is `request.is_secure()`. There is no in-app HTTPS redirect: the host's edge does that, and a redirect in the container would fail a plain-HTTP health check.
- **`make serve`** runs the same one-origin arrangement without Docker; **`make smoke`** runs `scripts/smoke_check.py` against any base URL. The check spends no provider quota: health, the page, the four built files with their types and cache headers, the JSON 404 and 405 under `/api/`, a refused foreign `Host`, and, with no keys configured, a `503 provider_not_configured` in the API's body. Against the hosted address a foreign `Host` is refused by Cloudflare's edge with a 403, which the check accepts as well as the app's 400; a local run demands the 400.

### Render configuration

- **`render.yaml`** describes the service: Docker runtime, health check on `/api/health`, and auto-deploy off, expected to mean a push never deploys by itself (whether `autoDeployTrigger: "off"` is the right blueprint key and value is not verified). The provider keys and the hostname are named there and set in the dashboard, never in the repository or the image.
- **Hosts.** `DJANGO_ALLOWED_HOSTS` is the only source. On Render it holds the service's hostname and `localhost`, comma-separated. Observed on 2026-11-14: with the hostname alone two deploys failed with "Port scan timeout reached", and with `localhost` added the deploy went green. Inferred from that and a [Render community report](https://community.render.com/t/health-check-invalid-http-host-header-localhost-10000/4438): Render's port and health checker calls with Host `localhost`; the Host it sends was not observed directly. In a local `docker run` the value is `localhost`. A request for the hosted page with any other Host is refused at Cloudflare's edge with a 403 before it reaches the app (observed); the app's own 400 is what a local container shows.

### Wake copy

Render documents that a free service sleeps after 15 minutes idle and that the first request afterwards waits about a minute while it wakes. One idle check on 2026-11-14 measured it once: after 16 min 32 s with no requests, an address search got its 200 answer after 13.2 s, with the edge holding the request and no gateway page (that the instance had slept is inferred from the timing). A fresh visit pays that wait for the page itself, before any app code exists, so no in-app text can cover it; the README says so.

The in-app copy covers a tab that stayed open while the host went back to sleep. In a build with `VITE_HOST_SLEEPS=1`, an address search still pending after 10 s says "Still searching. The server may be waking up after being idle. That can take up to a minute.", and a routes request still pending after 20 s adds "The server may be waking up after being idle. That can take up to a minute." The thresholds sit above the longest warm waits measured on the host ([performance.md](performance.md#hosted-render-free-plan-2026-11-14)). The weather wait cannot be the first request, so it carries none. `render.yaml` sets the value as a service environment value and the Dockerfile reads it as a build argument; the copy is present in the served bundle of the first deploy (observed 2026-11-14), which suggests Render passes the value to the image build. Local builds, tests and `make check` never set it.

### Logs

The app writes its own log lines to the console at INFO (the `LOGGING` setting in `config/base.py`: one handler on the root logger, which Django's loggers use too). The `httpx` and `httpcore` loggers are held at WARNING, because httpx logs every request URL, key included, at INFO. The lines the app writes for a weather request:

- `weather: N locations, M cached` for each request, and `weather: refused, waiting N s` for each rate-limit wait;
- `provider call timed out` with the provider's host name, the kind of timeout (`ReadTimeout`, `ConnectTimeout`, …), the attempt count (every try, connect tries included, so an Open-Meteo call that never connected shows `attempts=4`) and the seconds elapsed from its first slot (time queued for a slot is not counted), for a call that ends in a timeout after its retry;
- `provider call failed` in the same form, for a call that ends refused or unresolvable after its tries;
- `weather: deadline passed after 150 s` when the deadline passes.

Together they tell a weather 504 apart: one slow or unreachable Open-Meteo call, or a deadline spent on rate-limit waits. The hosted log has shown `provider call timed out` with `ConnectTimeout` after 20 s (2026-11-15, with the connect policy of one 10 s try and one retry). The app's own lines carry no provider URL, key or coordinate. uvicorn's access log is on, and it records each request's path with its query, so the text typed into an address search appears there.

### Hosted decisions

Taken on the evidence of the hosted run of 2026-11-14 ([performance.md](performance.md#hosted-render-free-plan-2026-11-14)):

- **Open-Meteo stays on the free plan, with no paid key.** The runs showed no 503, though at one time of day only, so this is not a guarantee ([Known limitations](../README.md#known-limitations)).
- **No compression in the app.** Cloudflare's edge already compresses the assets and the API answers.
- **The Positron basemap stays** (below).

### Basemap

The OpenFreeMap Positron style drew the plan on the hosted service with no failures (2026-11-14); every cell was Low there, so the colour ramp was not judged against it on the host. Switching to another style is a build-time act: set `VITE_BASEMAP_STYLE` to the style URL and redeploy. The Dockerfile reads it as a build argument of that name, and on Render the service environment value is expected to reach the image build the same way `VITE_HOST_SLEEPS` appears to; `VITE_BASEMAP_STYLE` has not been set on Render, so this is expected, not observed. A Carto style such as `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json` is the named alternative; that URL is untested here. A style other than Positron needs the heatmap's colour ramp and the stop and checkpoint halos re-measured against it first, because they were chosen against Positron's greys ([assumptions.md](assumptions.md#heatmap-and-corridor)).

### API docs page and content policy

- **`/api/docs`** is Ninja's interactive API page. Ninja is not an installed Django app, so it renders its CDN page, Swagger UI loaded from jsDelivr, rather than one that would ask this server for `/static/` files, which nothing serves. The schema it reads (`/api/openapi.json`) comes from the app itself.
- **That script runs with the origin's rights,** because there is no content security policy. That is acceptable here because the origin holds nothing for a script to steal or act with: no cookies, sessions or login, no user content, no stored data, and no provider key in the browser. The CDN files are versioned (`swagger-ui-dist@5`) but not integrity-pinned.
- **No content security policy.** A policy would protect little, and it would need a second place that knows the basemap host: the style URL is baked into the frontend at build time while a policy is a server header. It would have to allow the same-origin worker and scripts, inline styles (Material UI injects them), `data:` and `blob:` images, and connections to the basemap host for style, tiles, glyphs and sprites.
