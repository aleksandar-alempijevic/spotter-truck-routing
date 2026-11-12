# Architecture

## What exists now

Two programs that talk over HTTP, in one repository.

```
browser  ──►  Vite dev server (:5173)  ──/api──►  Django on uvicorn (:8000)
 React app     serves the app, proxies /api        Django Ninja endpoints
```

**Backend (`backend/`).** Django 6 with Django Ninja, served by uvicorn over ASGI so views can be `async`. Entry points: `config/asgi.py` (the application object uvicorn serves), `config/urls.py` (mounts the API at `/api/`), `api/api.py` (endpoints). Endpoints: `GET /api/health`, returning `{"status": "ok"}`, and `POST /api/routes` (below). Settings live in `config/base.py` and read environment variables; they refuse to start without a secret key unless debug is on. `config/settings.py` loads `.env` and then `base.py`; `config/settings_test.py` skips `.env` and uses dummy keys, so tests never touch real credentials or live APIs. There is no database; the settings declare none.

**Risk and ranking rules (`backend/risk_rules/`).** Plain Python with no Django or HTTP imports: the per-checkpoint risk level (`levels.py`), the route summary (`summary.py`) and the route ranking (`ranking.py`). Nothing calls the package yet; the weather endpoint will. The API layer imports it and it never imports the API layer, and a test checks that its source imports only the standard library. The rules are explained in [logic.md](logic.md).

**Routes and checkpoints.** Planning is split into three layers; imports run one way.

```
api  ──►  providers  ──►  routing        risk_rules (no imports either way)
```

- `routing/` is pure computation on a provider-neutral `Route` (geometry, length, travel time, time knots): checkpoints with ETAs, the overlap measure, via-city candidates from a hand-kept list, line reduction for the map, and route order and ids. Standard library only, checked by a test.
- `providers/` is the only package that imports `httpx`, knows a provider's URL and field names, or touches a key. `outbound.py` holds the shared policy: one HTTP client per planning request (opened inside the request's coroutine and closed on every exit, including the cancellation Django's ASGI handler applies on a client disconnect), a cap of 4 calls in flight, one retry on a timeout, transport error or 5xx (never on a 4xx), and provider-neutral errors with no URL, key or upstream body in them. `tomtom.py` is the TomTom truck-mode adapter; kilograms exist only there.
- `api/` holds the endpoints (`api.py`), the wire schemas (`schemas.py`) and the planner (`planner.py`), which only sequences the awaits: it makes the base call, decides whether to fill, makes the via calls, applies the overlap verdicts and builds the checkpoints. A test feeds the checkpoints into `risk_rules.summarize_route`, so the two packages' contract is checked without either importing the other.

**`POST /api/routes`** takes origin and destination coordinates, a departure instant, the load in pounds and the checkpoint spacing ([assumptions.md](assumptions.md) lists the limits). It asks TomTom for the fastest route and two alternatives. When fewer than three come back, it tries one via-city on each side of the fastest route, both calls at once, and keeps a via route only if it overlaps every other route by less than half. The response has one to three routes, fastest first, with ids `route-1` to `route-3` numbered from that order, each with its travel time in seconds, its miles, checkpoints (`mile`, `lat`, `lon`, `eta`), its line for the map as `[lon, lat]` pairs, its `source` (`provider` or `via_city`) and its `via` city. A `shortfall` with a reason and a message says why there are fewer than three: `no_distinct_alternative`, or `fill_incomplete` when the search for another route failed or ran out of its time budget. A failed fill never fails the request.

- **One distance scale per route.** A route's miles are TomTom's reported length, and polyline distances are scaled to it, so checkpoint positions and ETA knots agree (TomTom's own polyline length differs from it by up to 2.6 km on a long trip). Checkpoints are placed on the full-resolution line before it is reduced.
- **Checkpoint marks** start at mile 0, ascend strictly and end at the route's total miles. A length that is an exact multiple of the spacing does not get its last mark twice.
- **ETAs** are interpolated between TomTom's turn instructions, which carry cumulative distance and time. A route whose instruction times go backwards, or whose last time differs from the travel time, is rejected as a malformed provider response, never interpolated around.
- **Ids come from sorted order** (travel time, then miles), so the same routes get the same ids whatever order TomTom returns them in.
- **What the weather request sends back** is the response without `line`, `source` and `via`: `load_lb`, `checkpoint_interval_miles`, and per route `id`, `travel_time_seconds`, `total_miles` and `checkpoints`. The schemas expose it as the named parts `PlanParams` and `RouteCore`. The corridor is derived from the checkpoint positions, so no route line travels back; three of the longest test routes (about 10,500 miles together) make about 1,050 checkpoints at 10-mile spacing, roughly 100 kB of JSON.
- **Errors** on every endpoint have one body, `{code, message}`: validation 422, no route between the points 422, timeout 504, upstream failure or malformed response 502, rate limit or missing key 503. Messages carry no URL, key or provider text.
- **Time budget:** each TomTom call may take 50 s, and one planning request has 120 s in all. When the budget runs out during the fill, the routes in hand are returned with the `fill_incomplete` shortfall; during the base call it is a 504.

**Live check.** `backend/live_check.py` (outside `make check`, because it spends TomTom calls) runs the endpoint in-process over the seven trips of the feasibility spike, 25-mile spacing and an 80,000 lb load, on 2026-11-12:

| Trip | Routes | Latency | Response | TomTom calls |
|---|---|---|---|---|
| Los Angeles to New York | 3 (2 from TomTom, 1 via Albuquerque) | 14.7 s | 145 kB | 3 |
| Seattle to Miami | 3 | 12.0 s | 181 kB | 1 |
| Chicago to Los Angeles | 2 (no distinct third) | 8.5 s | 66 kB | 3 |
| Dallas to San Francisco | 3 | 8.4 s | 106 kB | 1 |
| Denver to Atlanta | 3 | 4.1 s | 73 kB | 1 |
| Chicago to Indianapolis | 3 | 1.9 s | 12 kB | 1 |
| Dallas to Houston | 3 | 1.6 s | 12 kB | 1 |

Instruction offsets and times stayed cumulative across the two legs of a via route. Lines carry 100 to 2,100 points after reduction. A point in the open Atlantic as origin is a TomTom 400 with the code `MAP_MATCHING_FAILURE`, reported as a 422 `no_route`. These are one-off measurements: TomTom's latency on long trips varies a lot between identical calls.

**Frontend (`frontend/`).** React 19, TypeScript, Vite and Material UI. TanStack Query owns all server requests: `src/api/health.ts` is the fetch function and `src/HealthStatus.tsx` renders its loading, error (with a Retry button) and success states. Query defaults (no refetch on focus, one retry) are set in `src/main.tsx`; the Material UI theme, which follows the system light or dark setting, is in `src/theme.ts`. Vite forwards `/api` to Django (`vite.config.ts`), so the browser sees one origin.

**Quality gates.** `make test` runs pytest (the health endpoint, the settings guard and the risk rules) and vitest (the status component and the fetch function). `make check` adds ruff lint and format checks on the backend, and `tsc`, ESLint and Prettier checks on the frontend.

## Where the planned parts go

The risk thresholds, load rules and route ranking already exist, as do the routes endpoint and its checkpoints (above); the weather endpoint will call the rules.

| Part | Place |
|---|---|
| Weather and the corridor grid | A backend module wrapping Open-Meteo, with caching by grid cell and forecast hour, exposed as a second endpoint |
| Map, trip form, route sidebar, forecast slider | New components under `frontend/src`; the map layers are drawn by MapLibre, not as React components |
| Hosting | One container serving the built frontend and the API from the same origin |

Planning is two requests, routes first and weather risk second, so the routes appear on the map before the weather finishes loading.
