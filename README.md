# Truck Route Safety

A web app that recommends the safest of up to three truck routes between two places. For each route it reads the weather along the road at the time the truck will be there, applies the assessment's risk and load-weight rules, and ranks the routes on weather risk first and travel time second. Full-stack take-home: React frontend, Django backend.

**Live app: <https://spotter-truck-routing-kxsl.onrender.com>.** It runs on Render's free plan, which puts the service to sleep after 15 minutes without requests, so the first visit can take about a minute. Hosting details are in [docs/architecture.md](docs/architecture.md#hosting).

## Quickstart

From a clone to a planned trip on your machine. You need [uv](https://docs.astral.sh/uv/), [Node.js](https://nodejs.org/) 22.12+, 24 or 26+, [pnpm](https://pnpm.io/) 9.15.4 and `make` (details in [Prerequisites](#prerequisites)).

1. **Get a TomTom key** (routes). Register at [my.tomtom.com](https://my.tomtom.com/); a key named "My first API key" is created with the account and listed under [API & SDK Keys](https://my.tomtom.com/keys). TomTom's [free tier](https://docs.tomtom.com/pricing) needs no credit card.
2. **Get a Geoapify key** (address search). Sign up at [myprojects.geoapify.com](https://myprojects.geoapify.com/), create a project and copy its API key. The [free plan](https://www.geoapify.com/pricing/) gives 3,000 credits a day and needs no credit card.
3. **Put both keys in `.env`** in the repository root:

   ```sh
   cp .env.example .env
   # then fill in the two lines:
   # TOMTOM_API_KEY=...
   # GEOAPIFY_API_KEY=...
   ```

   The weather source, [Open-Meteo](https://open-meteo.com/), needs no key. Nothing else in `.env` is needed locally.
4. **Install and run:**

   ```sh
   make install     # backend and frontend dependencies, once
   make backend     # terminal 1: Django API on http://127.0.0.1:8000
   make frontend    # terminal 2: React app on http://localhost:5173
   ```

5. **Open <http://localhost:5173>,** type an origin and a destination, a load, and plan.

Free tiers work: the app was built and is hosted on the free tiers of all three providers. TomTom's free tier is 20,000 routing requests a month, and one plan costs one to seven TomTom calls ([how routes are made](docs/architecture.md#how-routes-are-made)).

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
| Routes, checkpoints, risk levels, ETAs and route summaries on a map | The map in [frontend/src/map/](frontend/src/map/); route cards and checkpoint list in [frontend/src/panel/](frontend/src/panel/) |
| Weather heatmap along the corridor with a 0–48 hour slider | Corridor grid in [backend/weather/grid.py](backend/weather/grid.py); slider in [frontend/src/timeline/](frontend/src/timeline/); smoothness measured in [docs/performance.md](docs/performance.md#the-map-and-the-slider) |
| Hosted application | <https://spotter-truck-routing-kxsl.onrender.com> |

## How it decides

The rules are in [docs/logic.md](docs/logic.md), and the core code is four files: [backend/risk_rules/levels.py](backend/risk_rules/levels.py) (risk at a checkpoint), [backend/risk_rules/ranking.py](backend/risk_rules/ranking.py) (the ranking), [backend/routing/checkpoints.py](backend/routing/checkpoints.py) (checkpoints and ETAs) and [backend/weather/series.py](backend/weather/series.py) (the forecast at an ETA).

- **Risk at a checkpoint** is the worst of the wind, rain and snow bands; a value on a band edge goes to the higher band. The load rules raise the wind level only, and they compare against the cargo the driver entered, not the gross weight sent to TomTom.
- **Ranking** follows the assessment's order: fewest Severe miles, fewest High miles, lowest average risk, shortest travel time. A route with No Travel miles ranks below every route without them. For High miles and average risk, a difference of one checkpoint changing by one level counts as a tie, so travel time can decide; Severe has no tolerance.
- **Where the forecast does not reach,** a checkpoint has no level and its miles count as "no forecast", never as Low.

## Key assumptions

[docs/assumptions.md](docs/assumptions.md) lists every assumption with its reason. The ones that shape what a reviewer sees:

- **Trip limits.** Departure from 15 minutes ago to 48 hours ahead, cargo above 0 and at most 47,000 lb, every time shown in the origin's time zone ([details](docs/assumptions.md#trip-request)).
- **Routes stay inside the US.** A route is kept only when every country section TomTom reports is the US ([details](docs/assumptions.md#routes-and-checkpoints)).
- **TomTom is sent the gross weight,** the cargo plus an assumed 33,000 lb empty rig ([details](docs/assumptions.md#trip-request)).
- **Rest breaks are an optional extra, off by default;** the switch adds the federal hours-of-service stops to the ETAs ([readings](docs/assumptions.md#when-rest-breaks-are-on), [rule](docs/logic.md#4-rest-breaks-when-they-are-on)).

## Known limitations

- **The weather source is free and limited per IP address.** Open-Meteo's free tier allows 600 locations a minute, and the host's address is shared with other users, so a trip can wait for a minute window or fail with a 503. 10-mile spacing on a long trip can take about a minute ([quota](docs/assumptions.md#quota-and-cache)).
- **Connections from the host to Open-Meteo sometimes fail.** The hosted log has shown a weather call that timed out while connecting; the suspected cause is the host's shared outbound address. The app retries the connection quickly, and a weather request that still fails answers 504 or 502 ([deadline](docs/architecture.md#quota-waiting-and-deadline)).
- **No route between Alaska and the lower 48,** or for any trip with no road route inside the US: the app answers "no route" rather than show a route through Canada.
- **Sometimes fewer than three routes.** When TomTom and up to six via cities give no distinct third route, the app shows the routes it has with a note saying why ([how routes are made](docs/architecture.md#how-routes-are-made)).
- **No forecast beyond 96 hours.** Checkpoints past the forecast are shown as "no forecast"; this matters mostly for long trips with rest breaks on.
- **The slider was measured with software graphics only,** in headless Chromium; a real phone and a real GPU are not measured ([limits](docs/performance.md#limits)).
- **Two ranking quirks.** Ties do not chain, so adding a third route can change which of the other two wins ([example](docs/logic.md#ties-do-not-chain)); and a route with little forecast coverage gets a wide tolerance, so it can tie with a safer route and win on time ([example](docs/logic.md#no-forecast-miles)).

## Measured performance

[docs/performance.md](docs/performance.md) has the method, the results and what was not measured, with local and hosted runs labelled.

- **Slider:** dragging recolours only the cells whose level changed and makes no request; a WebGL compile that caused one slow frame per drag is moved out of the drag ([results](docs/performance.md#the-map-and-the-slider)).
- **Planning a trip:** on the hosted app a cross-country trip at 25-mile spacing showed its results about 20 s after the click, and one at 10-mile spacing about 40 s, including a wait for Open-Meteo's minute window. These runs, and the local ones, predate the US-only routing and the gross weight sent to TomTom ([hosted](docs/performance.md#hosted-render-free-plan-2026-11-14), [local](docs/performance.md#planning-a-trip)).
- **Build size:** the form renders from the entry chunk; the map and its worker load after it ([sizes](docs/performance.md#build-size)).

## Run it locally

### Prerequisites

| Tool | Version | Note |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | any recent | uv manages the Python version (3.13) and the backend dependencies |
| [Node.js](https://nodejs.org/) | 22.12+, 24 or 26+ | Vite and Vitest do not support 23 and 25 |
| [pnpm](https://pnpm.io/) | 9.15.4 | pinned in `frontend/package.json` |
| make | any | |
| [Docker](https://www.docker.com/) | any recent | only for the image |

### Development servers

The [Quickstart](#quickstart) commands start the API and the Vite dev server. The browser only talks to Vite, which forwards `/api` requests to Django, so there is one origin and no CORS configuration. Without a provider key the page says that the address search or the service is not set up. While the backend runs, the interactive API docs are at <http://127.0.0.1:8000/api/docs> (Swagger UI loads from a CDN, so the browser needs internet access).

### Configuration

Settings come from environment variables, optionally from a git-ignored `.env` in the repository root; [.env.example](.env.example) lists them. `make backend` turns on debug mode itself, so local development needs no Django setting. The routes endpoint needs `TOMTOM_API_KEY` and address search needs `GEOAPIFY_API_KEY`; without its key an endpoint answers 503 with a clear message and the rest of the app works. With debug off (the default) `DJANGO_SECRET_KEY` must be set. Tests ignore `.env` and use dummy values.

### One origin, as deployed

```sh
make serve       # build the frontend, then serve it and the API on http://127.0.0.1:8000
make smoke       # in another terminal: the deploy smoke check against that server

make image       # build the container image (needs Docker)
docker run --rm -e DJANGO_SECRET_KEY=any-value -e DJANGO_ALLOWED_HOSTS=localhost -e PORT=8000 -p 8000:8000 spotter-truck-routing
make smoke BASE_URL=http://localhost:8000   # the same check against the container
```

`make serve PORT=9000` and `make smoke PORT=9000` use another port; `make smoke BASE_URL=https://host.example` checks any other address. The container's check names `localhost` because the container allows only the hosts in `DJANGO_ALLOWED_HOSTS`, and `make smoke`'s default address, `127.0.0.1`, is refused with a 400. The check makes no provider call as long as no provider keys are configured: its last step expects the address search to answer 503 because its key is missing. With keys set, add `SMOKE_ARGS=--keys-set`, which skips that step. The container needs no `.env` and no provider keys to start; pass keys with `-e` to plan trips in it. The image runs one server process on purpose, because the forecast cache is shared by every request ([image and serving](docs/architecture.md#hosting)).

## Tests and checks

```sh
make test    # backend (pytest, including the risk rules) and frontend (vitest) tests
make check   # the tests, a check that the generated API types are current, ruff lint and format checks (backend), tsc, ESLint and Prettier checks (frontend), and a production build of the frontend
make types   # regenerate frontend/src/api/schema.d.ts from the backend's OpenAPI schema
```

Tests never make live calls: the providers are mocked, and the settings used by tests hold dummy keys. The build is part of `make check` because it is the only check that sees the map's worker file and its separately loaded chunk. The [Makefile](Makefile) is the one place that defines these commands.

Four scripts in `backend/` run the real providers and are not part of `make check`, because they spend quota:

| Script | What it does | Needs |
|---|---|---|
| `live_check.py` | the routes endpoint over seven test trips (about 12 TomTom calls) | `TOMTOM_API_KEY` |
| `live_address_check.py` | address search over 8 queries (up to 10 Geoapify calls: a city search with no match is followed by an untyped search) | `GEOAPIFY_API_KEY` |
| `live_weather_report_check.py` | one cross-country trip: routes (1 TomTom call), then weather, repeated to show the cache is used (about 500 Open-Meteo locations) | `TOMTOM_API_KEY` |
| `live_weather_check.py` | Open-Meteo's quota behaviour (about 1,650 locations) | no key |

`live_check.py` and `live_address_check.py` share `live_common.py` for set-up, the call budget and the output. Their recorded results are in [docs/performance.md](docs/performance.md#planning-a-trip).

```sh
uv --directory backend run python live_check.py /tmp/live-check.json
```

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
docs/       architecture.md, logic.md (the risk and ranking rules), assumptions.md, performance.md
Makefile    install / run / test / check / serve / image / smoke commands
scripts/    smoke_check.py, the deploy smoke check (standard library only)
Dockerfile  the one-container image; render.yaml is the host config
spikes/     throwaway feasibility experiments, each with its own README
```
