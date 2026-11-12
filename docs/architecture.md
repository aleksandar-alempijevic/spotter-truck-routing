# Architecture

## What exists now

Two programs that talk over HTTP, in one repository.

```
browser  ──►  Vite dev server (:5173)  ──/api──►  Django on uvicorn (:8000)
 React app     serves the app, proxies /api        Django Ninja endpoints
```

**Backend (`backend/`).** Django 6 with Django Ninja, served by uvicorn over ASGI so views can be `async`. Entry points: `config/asgi.py` (the application object uvicorn serves), `config/urls.py` (mounts the API at `/api/`), `api/api.py` (endpoints). Endpoints: `GET /api/health`, returning `{"status": "ok"}`, `POST /api/routes` and `GET /api/address-search` (below). Settings live in `config/base.py` and read environment variables; they refuse to start without a secret key unless debug is on. `config/settings.py` loads `.env` and then `base.py`; `config/settings_test.py` skips `.env` and uses dummy keys, so tests never touch real credentials or live APIs. There is no database; the settings declare none.

**Risk and ranking rules (`backend/risk_rules/`).** Plain Python with no Django or HTTP imports: the per-checkpoint risk level (`levels.py`), the route summary (`summary.py`) and the route ranking (`ranking.py`). Nothing calls the package yet; the weather endpoint will. The API layer imports it and it never imports the API layer, and a test checks that its source imports only the standard library. The rules are explained in [logic.md](logic.md).

**Routes and checkpoints.** Planning is split into three layers; imports run one way.

```
api  ──►  providers  ──►  routing        risk_rules (no imports either way)
```

- `routing/` is pure computation on a provider-neutral `Route` (geometry, length, travel time, time knots): checkpoints with ETAs, the overlap measure, via-city candidates from a hand-kept list, line reduction for the map, and route order and ids. Standard library only, checked by a test.
- `providers/` is the only package that imports `httpx`, knows a provider's URL and field names, or touches a key. `outbound.py` holds the shared policy: one HTTP client per planning request (opened inside the request's coroutine and closed on every exit, including the cancellation Django's ASGI handler applies on a client disconnect), a cap of 4 calls in flight (the one concurrency cap), one retry on a timeout, transport error or 5xx (never on a 4xx; a call made with `retry=False`, as address search is, is made once), and provider-neutral errors with no URL, key or upstream body in them. Each error class carries its code and its HTTP status, and the API's error handler and declared error responses are read from the classes. The `httpx` and `httpcore` loggers are held at WARNING by the `LOGGING` setting in `config/base.py`, because httpx logs every request URL, key included, at INFO. `tomtom.py` is the TomTom truck-mode adapter, where kilograms exist, and `geoapify.py` is the Geoapify autocomplete adapter.
- `api/` holds the endpoints (`api.py`), the wire schemas (`schemas.py`) and the planner (`planner.py`), which only sequences the awaits: it makes the base call, decides whether to fill, makes the via calls, applies the overlap verdicts and builds the checkpoints. A test feeds the checkpoints into `risk_rules.summarize_route`, so the two packages' contract is checked without either importing the other.

**`POST /api/routes`** takes origin and destination coordinates, a departure instant, the load in pounds and the checkpoint spacing ([assumptions.md](assumptions.md) lists the limits). It asks TomTom for the fastest route and two alternatives. When fewer than three come back, it fills the gap through a via-city: up to three cities on each side of the trip, chosen from a hand-kept list of 45 as at least 120 km from every route already in hand, least detour first, the two sides alternating. Every candidate's call starts at once and the outbound cap lets four run at a time; as each answer arrives it is kept only if it overlaps every route kept so far by less than half. Once three routes are kept the calls still running or waiting are cancelled, so a gap that fills early costs few calls (a call waiting for a slot never starts) and a trip with no distinct third route costs at most six. The overlap work and the parsing of TomTom's answers run in threads, so a long route's tens of thousands of points do not block the event loop, and each kept route's near-cells are computed once. The response has one to three routes, fastest first, with ids `route-1` to `route-3` numbered from that order, each with its travel time in seconds, its miles, checkpoints (`mile`, `lat`, `lon`, `eta`), its line for the map as `[lon, lat]` pairs, its `source` (`provider` or `via_city`) and its `via` city. A `shortfall` with a reason and a message says why there are fewer than three: `no_distinct_alternative`, or `fill_incomplete` when the search for another route failed or ran out of its time budget. The message names the cities that were tried. A failed fill never fails the request.

- **One distance scale per route.** A route's miles are TomTom's reported length, and polyline distances are scaled to it, so checkpoint positions and ETA knots agree (TomTom's own polyline length differs from it by up to 2.6 km on a long trip). Checkpoints are placed on the full-resolution line before it is reduced.
- **Checkpoint marks** start at mile 0, ascend strictly and end at the route's total miles. A length that is an exact multiple of the spacing does not get its last mark twice.
- **ETAs** are interpolated between TomTom's turn instructions, which carry cumulative distance and time. A route whose instruction times go backwards, or whose last time differs from the travel time, is rejected as a malformed provider response, never interpolated around.
- **Ids come from sorted order** (travel time, then miles), so the same routes get the same ids whatever order TomTom returns them in.
- **What the weather request sends back** is the response without `line`, `source` and `via`: `load_lb`, `checkpoint_interval_miles`, and per route `id`, `travel_time_seconds`, `total_miles` and `checkpoints`. The schema classes `PlanParams` and `RouteCore` are that subset; OpenAPI flattens them into the route schemas until the weather request references them. The corridor is derived from the checkpoint positions, so no route line travels back; three of the longest test routes (about 10,500 miles together) make about 1,050 checkpoints at 10-mile spacing, roughly 100 kB of JSON.
- **Errors** on every endpoint have one body, `{code, message}`, where `code` is one of a closed set (`validation_error`, `no_route`, `provider_timeout`, `provider_unavailable`, `provider_limited`, `provider_not_configured`, `provider_malformed_response`, `provider_error`) that a test ties to every error class, so the generated types carry it as a union. Statuses: validation 422, no route between the points 422, timeout 504, upstream failure or malformed response 502, rate limit or missing key 503. Messages carry no URL, key or provider text and name no single provider.
- **Time budget:** each TomTom call may take 50 s, and one planning request has one 120 s deadline covering the base call and the fill. When the budget runs out during the fill, the routes in hand are returned with the `fill_incomplete` shortfall; during the base call it is a 504.

**`GET /api/address-search?q=…`** returns US place suggestions from Geoapify's autocomplete with `filter=countrycode:us` and no place-type restriction, so a suggestion can be an address, a street or a city. The text is trimmed and must be 3 to 100 characters, checked before any provider call (otherwise 422). The response is `{suggestions: [{label, lat, lon, timezone}], attribution: {text, url}}`: `label` is the full text with the state, `timezone` an IANA name for converting a typed departure time, and the attribution (`Powered by Geoapify`) is what the free plan requires the UI to show. A suggestion without a label, coordinates or time zone is dropped, and no match is an empty list, not an error. The call has a 5 s timeout and is not retried. Its key is `GEOAPIFY_API_KEY`, and a missing one is a 503 `provider_not_configured`.

**Live check.** `backend/live_check.py` (outside `make check`, because it spends TomTom calls; it and `live_address_check.py` share `live_common.py` for set-up, the call budget and the output) runs the endpoint in-process over the seven trips of the feasibility spike, 25-mile spacing and an 80,000 lb load, on 2026-11-12:

| Trip | Routes | Latency | Response | TomTom calls |
|---|---|---|---|---|
| Los Angeles to New York | 3 (2 from TomTom, 1 via Albuquerque) | 14.7 s | 145 kB | 3 |
| Seattle to Miami | 3 | 12.0 s | 181 kB | 1 |
| Chicago to Los Angeles | 2 (no distinct third) on the first run; 3 after the search was widened (see below) | 8.5 s | 66 kB | 3 |
| Dallas to San Francisco | 3 | 8.4 s | 106 kB | 1 |
| Denver to Atlanta | 3 | 4.1 s | 73 kB | 1 |
| Chicago to Indianapolis | 3 | 1.9 s | 12 kB | 1 |
| Dallas to Houston | 3 | 1.6 s | 12 kB | 1 |

Instruction offsets and times stayed cumulative across the two legs of a via route. Lines carry 100 to 2,100 points after reduction. A point in the open Atlantic as origin is a TomTom 400 with the code `MAP_MATCHING_FAILURE`, reported as a 422 `no_route`. On Chicago to Los Angeles the first run tried one city per side, chosen against the fastest route only, and both overlapped. After the search was widened the same trip took 6 TomTom calls (the base call, then Denver at 0.66 overlap, Phoenix at 0.38 and three more that were cancelled once Phoenix filled the gap) and returned three routes in 8.8 s and 100 kB. These are one-off measurements: TomTom's latency on long trips varies a lot between identical calls.

Address search was run live on 2026-11-12 over 8 typed queries (a city, an ambiguous name, street addresses with and without a state, and a non-US place): every call answered in 0.7 to 2.8 s, every returned suggestion carried a time zone name, all were US places, and the non-US query returned an empty list.

**Frontend (`frontend/`).** React 19, TypeScript, Vite and Material UI. TanStack Query owns all server requests. The API's types are generated, not written by hand: `src/api/schema.d.ts` comes from the backend's OpenAPI schema (`make types`), and `make check` regenerates it and fails if the committed file differs. `src/api/health.ts` is the fetch function and `src/HealthStatus.tsx` renders its loading, error (with a Retry button) and success states. Query defaults (no refetch on focus, one retry) are set in `src/main.tsx`; the Material UI theme, which follows the system light or dark setting, is in `src/theme.ts`. Vite forwards `/api` to Django (`vite.config.ts`), so the browser sees one origin.

**Quality gates.** `make test` runs pytest (the endpoints with their providers mocked, the layering and key-leak checks, the settings guard and the risk rules) and vitest (the status component and the fetch function). `make check` adds the generated-types drift check, ruff lint and format checks on the backend, and `tsc`, ESLint and Prettier checks on the frontend.

## Where the planned parts go

The risk thresholds, load rules and route ranking already exist, as do the routes endpoint and its checkpoints (above); the weather endpoint will call the rules.

| Part | Place |
|---|---|
| Weather and the corridor grid | A backend module wrapping Open-Meteo, with caching by grid cell and forecast hour, exposed as a second endpoint |
| Map, trip form, route sidebar, forecast slider | New components under `frontend/src`; the map layers are drawn by MapLibre, not as React components |
| Hosting | One container serving the built frontend and the API from the same origin |

Planning is two requests, routes first and weather risk second, so the routes appear on the map before the weather finishes loading.
