# Truck Route Safety

A web app that recommends the safest of up to three truck routes between two places. For each route it reads the weather along the road at the time the truck will be there, applies the assessment's risk and load-weight rules, and ranks the routes on weather risk first and travel time second. Full-stack take-home: React frontend, Django backend.

**Status:** the app works end to end, locally and as one container that serves the frontend and the API from one origin. Hosting is described in [Hosting](#hosting).

## What the app does

The driver enters an origin and a destination (address search, US places), a departure, the load in pounds and the checkpoint spacing (10, 25 or 50 miles), and can switch rest breaks on. The routes appear first and the weather risk fills in after them:

- **Up to three truck routes** from TomTom, each with checkpoints every 10, 25 or 50 miles and an ETA at every checkpoint.
- **A risk level at each checkpoint** (Low, Moderate, High, Severe or No Travel) from the forecast for that checkpoint at its ETA, with the load rules applied.
- **A recommendation with its reason:** a route card per route, the first one explained step by step ("Why this route?"), and what safety costs in time for the others.
- **A map** with the routes, the checkpoints and a weather heatmap of the corridor, with a 0 to 48 hour forecast slider.

The layout is built up from a phone, with a bottom sheet, and uses the room on wider screens.

## How it decides

The rules are in [docs/logic.md](docs/logic.md); this is the summary.

**Risk at a checkpoint.** Wind, rain and snow are each put in a band with the assessment's thresholds, and the checkpoint takes the worst of the three. The load rules then apply to wind only: 55 mph or more is No Travel for any load, 45 to 54 mph with more than 30,000 lb is No Travel, and 35 to 44 mph with more than 40,000 lb is Severe. A value on a band edge goes to the higher band. Sustained wind decides; gusts are shown beside it. Where the forecast does not reach, the checkpoint has no level and its miles are counted as "no forecast", never as Low.

**Ranking.** Each checkpoint stands for the road up to the next one, so every route gets miles at each level and a mile-weighted average risk. Routes are filtered in the assessment's order of preference: fewest Severe miles, then fewest High miles, then lowest average risk, then shortest travel time. The assessment's list leaves out No Travel, so a route with any No Travel mile ranks below every route without one, and if the best route has No Travel miles the app recommends none. Severe has no tolerance. For High miles and average risk, a difference of one checkpoint changing by one level counts as a tie, because that is the smallest difference the forecast can show; travel time then decides. A strict order would almost never let time matter.

**Where the routes and weather come from.** [TomTom](https://developer.tomtom.com/) truck routing, sent the real load weight. When TomTom returns fewer than three routes, the app tries routing through a hub city and keeps the result only if it overlaps every other route by less than half; otherwise it shows two routes with a note. ETAs are interpolated from TomTom's turn instructions, with traffic predicted for the departure time. The forecast is [Open-Meteo](https://open-meteo.com/) (free, no key): hourly, read for the 0.1 degree cell (about 7 miles) holding the checkpoint, with wind interpolated between hours.

## Key assumptions

[docs/assumptions.md](docs/assumptions.md) lists them all with their reasons. The ones that shape what a reviewer sees:

- **Departure** is accepted from 15 minutes ago up to 48 hours ahead, the span of the heatmap slider. Load is more than 0 and at most 80,000 lb. Every time on screen is in the origin's time zone.
- **Rest breaks are off by default.** The assessment does not ask for them, so by default an ETA is driving time only. A form switch adds the federal hours-of-service stops (49 CFR 395.3) and the trip's door-to-door duration: a 30-minute break after 8 hours of driving, a 10-hour rest after 11, and a 34-hour restart after 60 hours of driving in the cycle. The rule is one function, [backend/routing/rest_breaks.py](backend/routing/rest_breaks.py).
- **When breaks are on,** the readings in [docs/assumptions.md](docs/assumptions.md#when-rest-breaks-are-on) apply, and the screen says so. The driver starts rested and only drives (no inspection, loading, fuelling or waiting), so the times are the earliest legal arrival. The 14-hour on-duty window is not modelled, because it cannot bind under that reading. The 60-hour cycle is the stricter of the 60 and 70-hour limits. Each stop is taken exactly where its limit is reached, which can be open highway, because the app has no places data. There is one driver, with no sleeper-berth split, and Alaska's different limits are not modelled.
- **A required stop shows the worst weather during the stop,** since the truck is parked through it. Stops do not enter a route's risk summary or the ranking, because a parked truck covers no miles. Break timing is fixed at the legal limits and does not move with the weather ([Future work](#future-work)).
- **The weather source is free and limited per address.** A trip can wait or fail with a 503 when the quota is used up; 10-mile spacing on a long trip can take about a minute, and the form says so.

## Measured performance

The method, results and limits are in [docs/performance.md](docs/performance.md). In summary:

- **Slider.** A scripted drag across every hour and back in headless Chromium at 390 by 844 with touch emulation, at 267 and 520 grid cells, with and without a 4x CPU slowdown. An earlier build showed one isolated frame of 100 to 217 ms per drag when the departure was under 30 minutes past the hour: the first draw of the trucks layer compiled its WebGL program mid-drag. The map now draws that layer once when the plan appears, and the same probe at a :10 departure shows no frame over 50 ms (largest gap 17 to 34 ms, 16 runs). At a :45 departure two of 12 runs under the 4x slowdown showed one 76 to 82 ms gap with no program built, so they are not this cause. In 3 of about 26 loaded runs a line-layer program linked mid-drag instead; the fix covers the trucks program only. The browser drew with software WebGL, so a real phone and a real GPU are not measured ([docs/performance.md](docs/performance.md#the-map-and-the-slider-frontend)).
- **Build size (gzip).** 205.53 kB for the entry that renders the form, then 296.57 kB for the map chunk and 147,800 bytes for its worker, which load after the form.
- **Planning a trip.** Live routes for seven test trips took 1.6 to 14.7 s; TomTom's latency on long trips varies a lot between identical calls. For Seattle to Miami, the trip with the most forecast locations, weather for three routes with 423 checkpoints and the corridor grid took 1.05 s cold and 0.12 s when repeated, from the shared forecast cache.

These numbers are from local runs. The hosted app has not been measured.

## Run it locally

### Prerequisites

| Tool                              | Version                                            | Install                                                                              |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [uv](https://docs.astral.sh/uv/)  | any recent                                         | `brew install uv`; it manages the Python version (3.13) and the backend dependencies |
| [Node.js](https://nodejs.org/)    | 22.12+, 24 or 26+ (Vite and Vitest skip 23 and 25) |                                                                                      |
| [pnpm](https://pnpm.io/)          | 9.15.4 (pinned in `frontend/package.json`)         | `corepack enable`, which ships with Node and picks the pinned version                |
| make                              | any                                                | preinstalled on macOS and most Linux                                                 |
| [Docker](https://www.docker.com/) | any recent, only for the image                     |                                                                                      |

You do not need to install Python or Django yourself.

### Development servers

```sh
make install     # install backend and frontend dependencies, once
make backend     # terminal 1: Django API on http://127.0.0.1:8000
make frontend    # terminal 2: React app on http://localhost:5173
```

Open <http://localhost:5173>. The trip form is the first thing on the page, and the map loads after it. Planning a trip needs the routing and address keys ([Configuration](#configuration)); without one, the page says which part is unavailable. While the backend runs, the interactive API docs are at <http://127.0.0.1:8000/api/docs> (the page loads Swagger UI from a CDN, so the browser needs internet access).

The browser only talks to the Vite dev server, which forwards `/api` requests to Django, so there is one origin and no CORS configuration.

### One origin, as deployed

```sh
make serve       # build the frontend, then serve it and the API on http://127.0.0.1:8000
make smoke       # in another terminal: the deploy smoke check against that server (no provider calls)

make image       # build the container image (needs Docker)
docker run --rm -e DJANGO_SECRET_KEY=any-value -e DJANGO_ALLOWED_HOSTS=localhost -e PORT=8000 -p 8000:8000 spotter-truck-routing
make smoke       # the same check against the container
```

`make serve PORT=9000` and `make smoke PORT=9000` use another port; `make smoke BASE_URL=https://host.example` checks any other address. The container needs no `.env` and no provider keys to start; without them the two provider endpoints answer 503 with a message saying which provider is not configured. The image runs one server process on purpose, because the forecast cache is shared by every request. See [docs/architecture.md](docs/architecture.md#hosting) for how the image is built and served.

## Tests and checks

```sh
make test    # backend (pytest, including the risk rules) and frontend (vitest) tests
make check   # the tests, a check that the generated API types are current, then ruff lint and format checks (backend), tsc, ESLint and Prettier checks (frontend), and a production build of the frontend
make types   # regenerate frontend/src/api/schema.d.ts from the backend's OpenAPI schema
```

Tests never make live calls: the providers are mocked, and the settings used by tests hold dummy keys. The build is part of `make check` because it is the only check that sees the map's worker file and its separately loaded chunk. The [Makefile](Makefile) is the one place that defines these commands, including the underlying `uv` and `pnpm` calls.

Four scripts in `backend/` run the real providers and are not part of `make check`, because they spend quota:

| Script                         | What it does                                                                                                                      | Needs              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `live_check.py`                | the routes endpoint over seven test trips (about 12 TomTom calls)                                                                 | `TOMTOM_API_KEY`   |
| `live_address_check.py`        | address search over 8 queries (8 Geoapify calls)                                                                                  | `GEOAPIFY_API_KEY` |
| `live_weather_report_check.py` | one cross-country trip: routes (1 TomTom call), then weather, repeated to show the cache is used (about 500 Open-Meteo locations) | `TOMTOM_API_KEY`   |
| `live_weather_check.py`        | Open-Meteo's quota behaviour (about 1,650 locations)                                                                              | no key             |

```sh
uv --directory backend run python live_check.py /tmp/live-check.json
```

## Configuration

Settings come from environment variables, optionally from a git-ignored `.env` in the repository root ([.env.example](.env.example) lists them). Local development needs no Django setting: `make backend` turns on debug mode itself. The routes endpoint needs `TOMTOM_API_KEY` and address search needs `GEOAPIFY_API_KEY`; without its key an endpoint answers 503 with a clear message and the rest of the app works. With debug off (the default, so a deployment is safe unless configured otherwise) `DJANGO_SECRET_KEY` must be set. Tests ignore `.env` and use dummy values.

## Hosting

The app is set up to run as one container on [Render's](https://render.com/) free plan, described by [render.yaml](render.yaml): the image above, a health check on `/api/health` (the `Host` Render's health probe sends is not yet verified against the allowed-hosts list; the first deploy tests it), and auto-deploy off. Provider keys and the service's hostname are set in the host's dashboard, never in the repository or the image.

**The first load can take about a minute.** A free Render service sleeps after 15 minutes without requests and takes about a minute to wake, and the first request after that waits for it. Once the page has loaded, a slow address search or routes request says that the server may be waking up.

The hosted address and measurements of the hosted app will be added to this section when the service is running.

## Future work

1. **Weather-aware rest timing.** Break timing is fixed at the legal limits today, and each stop shows the weather at its place and time. A later version could use the forecast to choose when and where a break is taken.
2. **Local detours on via-city routes.** A route made by sending the truck through a hub city is chosen by geometry alone, so it can include a detour into the city and back. Snapping the via point to an interstate interchange, or routing through circle waypoints, would address it ([docs/assumptions.md](docs/assumptions.md#routes-and-checkpoints)).

## Repository layout

```
backend/    Django + Django Ninja API on uvicorn (ASGI), Python 3.13, managed by uv
            risk_rules/ holds the risk and ranking rules (plain Python, no Django)
            routing/ holds route computations: checkpoints, ETAs, rest breaks, overlap (plain Python)
            weather/ holds forecast series, sampling and the corridor grid (plain Python)
            providers/ holds outbound HTTP to TomTom, Geoapify and Open-Meteo and the shared request policy
frontend/   React + TypeScript + Vite + Material UI app, managed by pnpm
docs/       architecture.md, logic.md (the risk and ranking rules), assumptions.md, performance.md
Makefile    install / run / test / check / serve / image / smoke commands
scripts/    smoke_check.py, the deploy smoke check (standard library only)
Dockerfile  the one-container image; render.yaml is the host config
spikes/     throwaway feasibility experiments, each with its own README
```
