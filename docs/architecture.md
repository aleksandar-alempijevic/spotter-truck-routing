# Architecture

## What exists now

Two programs that talk over HTTP, in one repository.

```
browser  ──►  Vite dev server (:5173)  ──/api──►  Django on uvicorn (:8000)
 React app     serves the app, proxies /api        Django Ninja endpoints
```

**Backend (`backend/`).** Django 6 with Django Ninja, served by uvicorn over ASGI so views can be `async`. Entry points: `config/asgi.py` (the application object uvicorn serves), `config/urls.py` (mounts the API at `/api/`), `api/api.py` (endpoints). The only endpoint is `GET /api/health`, returning `{"status": "ok"}`. Settings live in `config/base.py` and read environment variables; they refuse to start without a secret key unless debug is on. `config/settings.py` loads `.env` and then `base.py`; `config/settings_test.py` skips `.env` and uses dummy keys, so tests never touch real credentials or live APIs. There is no database; the settings declare none.

**Risk and ranking rules (`backend/risk_rules/`).** Plain Python with no Django or HTTP imports: the per-checkpoint risk level (`levels.py`), the route summary (`summary.py`) and the route ranking (`ranking.py`). Nothing calls the package yet; the weather endpoint will. The API layer imports it and it never imports the API layer, and a test checks that its source imports only the standard library. The rules are explained in [logic.md](logic.md).

**Frontend (`frontend/`).** React 19, TypeScript, Vite and Material UI. TanStack Query owns all server requests: `src/api/health.ts` is the fetch function and `src/HealthStatus.tsx` renders its loading, error (with a Retry button) and success states. Query defaults (no refetch on focus, one retry) are set in `src/main.tsx`; the Material UI theme, which follows the system light or dark setting, is in `src/theme.ts`. Vite forwards `/api` to Django (`vite.config.ts`), so the browser sees one origin.

**Quality gates.** `make test` runs pytest (the health endpoint, the settings guard and the risk rules) and vitest (the status component and the fetch function). `make check` adds ruff lint and format checks on the backend, and `tsc`, ESLint and Prettier checks on the frontend.

## Where the planned parts go

The risk thresholds, load rules and route ranking already exist (above); the endpoints below will call them.

| Part | Place |
|---|---|
| Routes, checkpoints and ETAs | A backend module wrapping the routing provider (TomTom truck mode) behind an async `httpx` client, exposed as a routes endpoint |
| Weather and the corridor grid | A backend module wrapping Open-Meteo, with caching by grid cell and forecast hour, exposed as a second endpoint |
| Map, trip form, route sidebar, forecast slider | New components under `frontend/src`; the map layers are drawn by MapLibre, not as React components |
| Hosting | One container serving the built frontend and the API from the same origin |

Planning will be two requests, routes first and weather risk second, so the routes appear on the map before the weather finishes loading.
