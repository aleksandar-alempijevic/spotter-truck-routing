# Truck Route Safety

A web app that recommends the safest of three truck routes between two places, using the weather along each route at the time the truck will be there, the load weight and the travel time. Full-stack take-home: React frontend, Django backend.

**Status:** the app works end to end; hosting is not set up yet. The driver plans a trip in the React app: origin and destination from address search, a departure, the load in pounds and the checkpoint spacing. The routes appear first and the weather risk fills in after them, on a map with a 0 to 48 hour forecast slider and a route card for each route that says why the first one is recommended. The layout is built up from a phone, with a bottom sheet, and uses the room on wider screens ([docs/architecture.md](docs/architecture.md)). The backend serves it: `POST /api/routes` returns up to three truck routes with checkpoints and ETAs from TomTom ([docs/architecture.md](docs/architecture.md)). `POST /api/weather` takes those routes back and returns, for each checkpoint, the Open-Meteo forecast at its ETA and a risk level ([docs/logic.md](docs/logic.md)), a summary per route, the ranking with its reasons, and a 49-hour risk grid of the corridor for a map slider. `GET /api/address-search` returns US place suggestions from Geoapify.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | any recent | `brew install uv`; it manages the Python version (3.13) and the backend dependencies |
| [Node.js](https://nodejs.org/) | 22.12+, 24 or 26+ (Vite and Vitest skip 23 and 25) | |
| [pnpm](https://pnpm.io/) | 9.15.4 (pinned in `frontend/package.json`) | `corepack enable`, which ships with Node and picks the pinned version |
| make | any | preinstalled on macOS and most Linux |

You do not need to install Python or Django yourself.

## Run it locally

```sh
make install     # install backend and frontend dependencies, once
make backend     # terminal 1: Django API on http://127.0.0.1:8000
make frontend    # terminal 2: React app on http://localhost:5173
```

Open <http://localhost:5173>. The trip form is the first thing on the page, and the map loads after it. Planning a trip needs the routing and address keys in `.env` ([Configuration](#configuration)); without one the page says which part is unavailable. While the backend runs, the interactive API docs are at <http://127.0.0.1:8000/api/docs>.

The browser only talks to the Vite dev server, which forwards `/api` requests to Django, so there is one origin and no CORS configuration.

## Tests and checks

```sh
make test    # backend (pytest, including the risk rules) and frontend (vitest) tests
make check   # the tests, a check that the generated API types are current, then ruff lint and format checks (backend), tsc, ESLint and Prettier checks (frontend), and a production build of the frontend
make types   # regenerate frontend/src/api/schema.d.ts from the backend's OpenAPI schema
```

Tests never make live calls: the providers are mocked, and the settings used by tests hold dummy keys. `backend/live_check.py` runs the routes endpoint against the real TomTom over seven test trips (about 12 calls); it needs `TOMTOM_API_KEY` in `.env` and is not part of `make check`. `backend/live_address_check.py` does the same for address search against Geoapify (8 calls) and needs `GEOAPIFY_API_KEY`. `backend/live_weather_report_check.py` routes one cross-country trip with TomTom (1 call), sends the routes to the weather endpoint and repeats the request to show the cache is used; it spends about 500 Open-Meteo locations, which need no key. `backend/live_weather_check.py` measures Open-Meteo's quota behaviour (about 1,650 locations).

```sh
uv --directory backend run python live_check.py /tmp/live-check.json
```

The build is part of `make check` because it is the only check that sees the map's worker file and its separately loaded chunk. The [Makefile](Makefile) is the one place that defines these commands, including the underlying `uv` and `pnpm` calls.

## Configuration

Settings come from environment variables, optionally from a git-ignored `.env` in the repository root ([.env.example](.env.example) lists them). Local development needs no Django setting: `make backend` turns on debug mode itself. The routes endpoint needs `TOMTOM_API_KEY` and address search needs `GEOAPIFY_API_KEY`; without its key an endpoint answers 503 with a clear message and the rest of the app works. With debug off (the default, so a deployment is safe unless configured otherwise) `DJANGO_SECRET_KEY` must be set. Tests ignore `.env` and use dummy values.

## Repository layout

```
backend/    Django + Django Ninja API on uvicorn (ASGI), Python 3.13, managed by uv
            risk_rules/ holds the risk and ranking rules (plain Python, no Django)
            routing/ holds route computations: checkpoints, ETAs, overlap (plain Python)
            weather/ holds forecast series, sampling and the corridor grid (plain Python)
            providers/ holds outbound HTTP to TomTom, Geoapify and Open-Meteo and the shared request policy
frontend/   React + TypeScript + Vite + Material UI app, managed by pnpm
docs/       architecture.md, logic.md (the risk and ranking rules), assumptions.md
Makefile    install / run / test / check commands
spikes/     throwaway feasibility experiments, each with its own README
```
