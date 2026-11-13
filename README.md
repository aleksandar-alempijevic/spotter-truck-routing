# Truck Route Safety

A web app that recommends the safest of three truck routes between two places, using the weather along each route at the time the truck will be there, the load weight and the travel time. Full-stack take-home: React frontend, Django backend.

**Status:** in progress. The React page calls a Django health endpoint and shows the answer. `POST /api/routes` returns up to three truck routes with checkpoints and ETAs from TomTom ([docs/architecture.md](docs/architecture.md)). `POST /api/weather` takes those routes back and returns, for each checkpoint, the Open-Meteo forecast at its ETA and a risk level ([docs/logic.md](docs/logic.md)), a summary per route, the ranking with its reasons, and a 49-hour risk grid of the corridor for a map slider. `GET /api/address-search` returns US place suggestions from Geoapify. The UI uses none of these yet; the map and the trip form come in later steps, and the architecture doc says where each will go.

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

Open <http://localhost:5173>. A green "API status: ok" box means the browser reached Django. With the backend stopped, the page says so and offers a Retry button. While the backend runs, the interactive API docs are at <http://127.0.0.1:8000/api/docs>.

The browser only talks to the Vite dev server, which forwards `/api` requests to Django, so there is one origin and no CORS configuration.

## Tests and checks

```sh
make test    # backend (pytest, including the risk rules) and frontend (vitest) tests
make check   # the tests, a check that the generated API types are current, then ruff lint and format checks (backend), and tsc, ESLint and Prettier checks (frontend)
make types   # regenerate frontend/src/api/schema.d.ts from the backend's OpenAPI schema
```

Tests never make live calls: the providers are mocked, and the settings used by tests hold dummy keys. `backend/live_check.py` runs the routes endpoint against the real TomTom over seven test trips (about 12 calls); it needs `TOMTOM_API_KEY` in `.env` and is not part of `make check`. `backend/live_address_check.py` does the same for address search against Geoapify (8 calls) and needs `GEOAPIFY_API_KEY`. `backend/live_weather_report_check.py` routes one cross-country trip with TomTom (1 call), sends the routes to the weather endpoint and repeats the request to show the cache is used; it spends about 500 Open-Meteo locations, which need no key. `backend/live_weather_check.py` measures Open-Meteo's quota behaviour (about 1,650 locations).

```sh
uv --directory backend run python live_check.py /tmp/live-check.json
```

The [Makefile](Makefile) is the one place that defines these commands, including the underlying `uv` and `pnpm` calls.

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
