# Truck Route Safety

A web app that recommends the safest of up to three truck routes between two places. For each route it reads the weather along the road at the time the truck will be there, applies the assessment's risk and load-weight rules, and ranks the routes on weather risk first and travel time second. Full-stack take-home: React frontend, Django backend.

**Live app: <https://spotter-truck-routing-kxsl.onrender.com>.** It runs on Render's free plan, which puts the service to sleep after 15 minutes without requests, so the first visit can take about a minute. Hosting is described in [docs/hosting.md](docs/hosting.md).

## Quickstart

From a clone to a planned trip on your machine.

1. **Install the tools.**
   - [uv](https://docs.astral.sh/uv/getting-started/installation/) (for example `brew install uv`); it installs Python 3.13 and the backend dependencies itself.
   - [Node.js](https://nodejs.org/) 22.12+, 24 or 26+ (Vite and Vitest do not support 23 and 25).
   - pnpm 9.15.4, pinned in `frontend/package.json`: run `corepack enable` and corepack uses the pinned version. Node 22 and 24 ship corepack; on later versions install it first with `npm install -g corepack`.
   - `make`.
2. **Get a TomTom key** (routes). Register at [my.tomtom.com](https://my.tomtom.com/); a key named "My first API key" is created with the account and listed under [API & SDK Keys](https://my.tomtom.com/keys). TomTom's [free tier](https://docs.tomtom.com/pricing) needs no credit card.
3. **Get a Geoapify key** (address search). Sign up at [myprojects.geoapify.com](https://myprojects.geoapify.com/), create a project and copy its API key. The [free plan](https://www.geoapify.com/pricing/) gives 3,000 credits a day and needs no credit card.
4. **Put both keys in `.env`** in the repository root:

   ```sh
   cp .env.example .env
   # then fill in the two lines:
   # TOMTOM_API_KEY=...
   # GEOAPIFY_API_KEY=...
   ```

   The weather source, [Open-Meteo](https://open-meteo.com/), needs no key. Nothing else in `.env` is needed locally.
5. **Install and run:**

   ```sh
   make install     # backend and frontend dependencies, once
   make backend     # terminal 1: Django API on http://127.0.0.1:8000
   make frontend    # terminal 2: React app on http://localhost:5173
   ```

6. **Open <http://localhost:5173>,** type an origin and a destination, a load, and plan.

Free tiers work: the app was built and is hosted on the free tiers of all three providers. TomTom's free tier is 20,000 routing requests a month. One plan makes one to seven TomTom calls (the base call and up to six via cities), and each call is retried once after a timeout or a server error, so a plan sends at most 14 requests ([how routes are made](docs/architecture.md#how-routes-are-made)).

The browser only talks to the Vite dev server, which forwards `/api` requests to Django, so there is one origin and no CORS configuration. Without a provider key, that endpoint answers 503 with "A data provider is not configured on this server." and the page says that the address search or the service is not set up; the rest of the app works. While the backend runs, the interactive API docs are at <http://127.0.0.1:8000/api/docs> (Swagger UI loads from a CDN, so the browser needs internet access). To run the app the way it is deployed, as one server or one container, see [docs/hosting.md](docs/hosting.md#run-it-as-deployed).

## What the app does

The driver enters an origin and a destination (address search, US places), a departure, the cargo weight in pounds and the checkpoint spacing (10, 25 or 50 miles), and can switch rest breaks on. The routes appear first and the weather risk fills in after them:

- **Up to three truck routes** from TomTom, each with checkpoints at the chosen spacing and an ETA at every checkpoint.
- **A risk level at each checkpoint** (Low, Moderate, High, Severe or No Travel) from the forecast for that checkpoint at its ETA, with the load rules applied.
- **A recommendation with its reason:** a card per route, the first one explained step by step ("Why this route?"), and what safety costs in time for the others.
- **A map** with the routes, the checkpoints and a weather heatmap of the corridor, with a 0 to 48 hour forecast slider.

The layout is built up from a phone, with a bottom sheet, and uses the room on wider screens.

## Requirements and where they are met

| Assessment requirement | Where the app meets it |
|---|---|
| Origin, destination, departure date and time, load weight | The trip form, [frontend/src/form/](frontend/src/form/); limits in [docs/assumptions.md](docs/assumptions.md#trip-request) |
| 3 route options from a routing API | TomTom truck routing plus a via-city fill when TomTom returns fewer: [backend/api/planner.py](backend/api/planner.py), [docs/architecture.md](docs/architecture.md#how-routes-are-made) |
| Weather every 10 / 25 / 50 miles at the truck's ETA | Checkpoints and ETAs in [backend/routing/checkpoints.py](backend/routing/checkpoints.py); the forecast read at each ETA in [backend/weather/series.py](backend/weather/series.py); [docs/architecture.md](docs/architecture.md#weather) |
| Risk from the provided risk and load rules | [backend/risk_rules/levels.py](backend/risk_rules/levels.py), explained in [docs/logic.md](docs/logic.md#1-risk-level-at-one-checkpoint) |
| Recommend the best route, balancing risk and travel time | [backend/risk_rules/ranking.py](backend/risk_rules/ranking.py), explained in [docs/logic.md](docs/logic.md#3-ranking) |
| Routes, checkpoints, risk levels, ETAs and route summaries on a map | The map in [frontend/src/map/](frontend/src/map/); route cards, chips and checkpoint list in [frontend/src/panel/](frontend/src/panel/) |
| Weather heatmap along the corridor with a 0–48 hour slider | Corridor grid in [backend/weather/grid.py](backend/weather/grid.py); slider in [frontend/src/timeline/](frontend/src/timeline/); smoothness measured in [docs/performance.md](docs/performance.md#the-map-and-the-slider) |
| Hosted application | <https://spotter-truck-routing-kxsl.onrender.com> |

## How it decides

The rules are in [docs/logic.md](docs/logic.md), and the core code is four files: [backend/risk_rules/levels.py](backend/risk_rules/levels.py) (risk at a checkpoint), [backend/risk_rules/ranking.py](backend/risk_rules/ranking.py) (the ranking), [backend/routing/checkpoints.py](backend/routing/checkpoints.py) (checkpoints and ETAs) and [backend/weather/series.py](backend/weather/series.py) (the forecast at an ETA).

- **Risk at a checkpoint** is the worst of the wind, rain and snow bands; a value on a band edge goes to the higher band. The load rules raise the wind level only, and they compare against the cargo the driver entered, not the gross weight sent to TomTom. Sustained wind decides; a gust of 45 mph or more adds a blow-over warning but never changes the level or the ranking.
- **Ranking** follows the assessment's order: fewest Severe miles, fewest High miles, lowest average risk, shortest travel time. A route with No Travel miles ranks below every route without them. For High miles and average risk, a difference of one checkpoint changing by one level counts as a tie, so travel time can decide; Severe has no tolerance.
- **Where the forecast does not reach,** a checkpoint has no level and its miles count as "no forecast", never as Low.

## Key assumptions

[docs/assumptions.md](docs/assumptions.md) lists every assumption with its reason. The ones that shape what a reviewer sees:

- **Trip limits.** Departure from 15 minutes ago to 48 hours ahead, cargo above 0 and at most 47,000 lb, every time shown in the origin's time zone ([details](docs/assumptions.md#trip-request)).
- **Routes stay inside the US,** its territories included ([details](docs/assumptions.md#routes-and-checkpoints)).
- **TomTom is sent the gross weight,** the cargo plus an assumed 33,000 lb empty rig ([details](docs/assumptions.md#trip-request)).
- **Rest breaks are an optional extra, off by default;** the switch adds the federal hours-of-service stops to the ETAs ([readings](docs/assumptions.md#when-rest-breaks-are-on), [rule](docs/logic.md#4-rest-breaks-when-they-are-on)).

## Known limitations

- **The weather source is free and limited per IP address,** and the host's address is shared with other users, so a trip can wait for Open-Meteo's minute window or fail with a 503. 10-mile spacing on a long trip can take about a minute ([quota](docs/assumptions.md#quota-and-cache)).
- **Connections from the host to Open-Meteo sometimes fail.** The hosted log has shown a weather call that timed out while connecting; the suspected cause is the host's shared outbound address. The app retries the connection quickly, and a weather request that still fails answers 504 or 502 ([deadline](docs/architecture.md#quota-waiting-and-deadline)).
- **No route between Alaska and the lower 48,** or for any trip with no road route inside the US: the app shows "No truck route found" and says that routes stay inside the US, rather than show a route through Canada.
- **Sometimes fewer than three routes.** When TomTom and up to six via cities give no distinct third route, the app shows the routes it has with a note saying why ([how routes are made](docs/architecture.md#how-routes-are-made)).
- **No forecast beyond 96 hours.** Checkpoints past the forecast are shown as "no forecast"; this matters mostly for long trips with rest breaks on.
- **The slider was measured with software graphics only,** in headless Chromium; a real phone and a real GPU are not measured ([limits](docs/performance.md#limits)).
- **Two ranking quirks.** Ties do not chain, so adding a third route can change which of the other two wins ([example](docs/logic.md#ties-do-not-chain)); and a route with little forecast coverage gets a wide tolerance, so it can tie with a safer route and win on time ([example](docs/logic.md#no-forecast-miles)).

## Measured performance

[docs/performance.md](docs/performance.md) has the method, the results with the build and date of each, and what was not measured.

- **Slider** (headless Chromium, software WebGL, phone size). A 12-drag run had a median frame gap of 16.7 ms (95th percentile 16.7 to 16.8 ms) and no request during a drag. After a fix that moves a WebGL compile out of the drag, 22 of 34 drags had no frame over 50 ms, with the largest gap 17 to 34 ms. The other 12 were at a departure of :45 under a 4x CPU slowdown on a loaded machine, and two of them showed one gap each, of 76 and 82 ms. A probe of the current fix showed one 68 ms gap at 4x with no compile behind it. None of these three gaps was traced, and in 3 of about 26 loaded runs another layer's program compiled mid-drag. On the hosted build of 2026-11-14, one drag per rate had no frame over 50 ms (largest gap 41.8 ms) ([results](docs/performance.md#the-map-and-the-slider)).
- **Planning a trip** (local, on the current code). Routes for seven test trips took 1.8 to 11.9 s; weather for Seattle to Miami at 25-mile spacing (518 forecast locations) took 0.83 s cold and 0.09 s from the cache. On the hosted build of 2026-11-14 a cross-country trip showed its results about 20 s after the click at 25-mile spacing and about 40 s at 10-mile spacing, including a wait for Open-Meteo's minute window ([results](docs/performance.md#planning-a-trip)).
- **Build size:** the form renders from a 207 kB (gzip) entry; the map chunk and its worker load after it ([sizes](docs/performance.md#build-size)).

## Tests and checks

```sh
make test    # backend (pytest, including the risk rules) and frontend (vitest) tests
make check   # the tests, a check that the generated API types are current, ruff lint and format checks (backend), tsc, ESLint and Prettier checks (frontend), and a production build of the frontend
make types   # regenerate frontend/src/api/schema.d.ts from the backend's OpenAPI schema
```

Tests never make live calls: the providers are mocked, and the settings used by tests hold dummy keys. The build is part of `make check` because it is the only check that sees the map's worker file and its separately loaded chunk. The [Makefile](Makefile) is the one place that defines these commands. What the tests cover is in [docs/architecture.md](docs/architecture.md#what-the-tests-cover).

Four scripts in `backend/` run the real providers and are not part of `make check`, because they spend quota:

| Script | What it does | Needs |
|---|---|---|
| `live_check.py` | the routes endpoint over seven test trips and one unroutable probe (13 TomTom calls in the last run) | `TOMTOM_API_KEY` |
| `live_address_check.py` | address search over 8 queries (up to 10 Geoapify calls: a city search with no match is followed by an untyped search) | `GEOAPIFY_API_KEY` |
| `live_weather_report_check.py` | one cross-country trip: routes (1 TomTom call), then weather, repeated to show the cache is used (about 500 Open-Meteo locations) | `TOMTOM_API_KEY` |
| `live_weather_check.py` | Open-Meteo's quota behaviour (about 1,650 locations) | no key |

`live_check.py` and `live_address_check.py` share `live_common.py` for set-up, the call budget and the output. Their recorded results are in [docs/performance.md](docs/performance.md#planning-a-trip).

```sh
uv --directory backend run python live_check.py /tmp/live-check.json
```

## Configuration

Settings come from environment variables, optionally from a git-ignored `.env` in the repository root; [.env.example](.env.example) lists them. `make backend` turns on debug mode itself, so local development needs no Django setting. The routes endpoint needs `TOMTOM_API_KEY` and address search needs `GEOAPIFY_API_KEY`. With debug off (the default) `DJANGO_SECRET_KEY` must be set. Tests ignore `.env` and use dummy values.

## Future work

1. **Weather-aware rest timing.** Break timing is fixed at the legal limits, and each stop shows the weather at its place and time. A later version could use the forecast to choose when and where a break is taken.
2. **Local detours on via-city routes.** A route made by sending the truck through a hub city is chosen by geometry alone, so it can include a detour into the city and back. Snapping the via point to an interstate interchange, or routing through circle waypoints, would address it ([docs/assumptions.md](docs/assumptions.md#routes-and-checkpoints)).

## Repository layout

```
backend/    Django + Django Ninja API on uvicorn (ASGI), Python 3.13, managed by uv
            risk_rules/ holds the risk and ranking rules (plain Python, no Django)
            routing/ holds route computations: checkpoints, ETAs, rest breaks, overlap (plain Python)
            weather/ holds forecast series, sampling and the corridor grid (plain Python)
            providers/ holds outbound HTTP to TomTom, Geoapify and Open-Meteo and the shared request policy
frontend/   React + TypeScript + Vite + Material UI app, managed by pnpm
docs/       architecture.md, api.md, logic.md (the risk and ranking rules), assumptions.md,
            performance.md, hosting.md
Makefile    install / run / test / check / serve / image / smoke commands
scripts/    smoke_check.py, the deploy smoke check (standard library only)
Dockerfile  the one-container image; render.yaml is the host config
spikes/     throwaway feasibility experiments, each with its own README
```
