# Hosting

The live app is <https://spotter-truck-routing-kxsl.onrender.com>, on Render's free plan. One container serves the built frontend and the API from the same origin, so the browser needs no CORS setup and the app calls `/api/...` on whatever host it was loaded from. This page covers running the app that way, the image, the Render set-up, the wake copy, the logs and the hosting choices. Hosted measurements are in [performance.md](performance.md#hosted-render-free-plan-2026-11-14).

```
browser ──► host's HTTPS edge ──► container: uvicorn (one process)
                                    StaticBuild  ──►  /  and  /assets/*   the built frontend
                                    Django       ──►  /api/*              Ninja, `{code, message}` errors
```

## Run it as deployed

`make serve` builds the frontend and serves it and the API from one uvicorn process, the way the image does; [Docker](https://www.docker.com/) is needed only for the image.

```sh
make serve       # build the frontend, then serve it and the API on http://127.0.0.1:8000
make smoke       # in another terminal: the deploy smoke check against that server

make image       # build the container image
docker run --rm -e DJANGO_SECRET_KEY=any-value -e DJANGO_ALLOWED_HOSTS=localhost -e PORT=8000 -p 8000:8000 spotter-truck-routing
make smoke BASE_URL=http://localhost:8000   # the same check against the container
```

- **Keys and the smoke check.** `make serve` reads `.env`, so after the [Quickstart](../README.md#quickstart) the server has provider keys. Plain `make smoke` then fails its last step, which expects address search to answer 503 for a missing key, and that step spends one Geoapify call. With keys configured, run `make smoke SMOKE_ARGS=--keys-set`, which skips the step. The container reads no `.env`; without `-e` keys its provider endpoints answer 503, and plain `make smoke` passes.
- **What the check covers.** It spends no provider quota when it skips that step: health, the page, the four built files with their types and cache headers, the JSON 404 and 405 under `/api/`, a refused foreign `Host`, and, with no keys configured, a `503 provider_not_configured` in the API's body. Against the hosted address a foreign `Host` is refused by Cloudflare's edge with a 403, which the check accepts as well as the app's 400; a local run demands the 400. It is not part of `make check` because it needs a running server.
- **Ports and hosts.** `make serve PORT=9000` and `make smoke PORT=9000` use another port; `make smoke BASE_URL=https://host.example` checks any other address. The container's check names `localhost` because the container allows only the hosts in `DJANGO_ALLOWED_HOSTS`, and `make smoke`'s default address, `127.0.0.1`, is refused with a 400.
- **The container** needs no `.env` and no provider keys to start; pass keys with `-e` to plan trips in it.

## Image and serving

- **`Dockerfile`** builds in two stages: Node builds `frontend/dist` (pnpm as pinned in `package.json`), then a Python 3.13 image installs the backend's locked, non-dev dependencies and copies in only the backend packages and the build (no tests, live-check scripts, spikes or docs). It runs as a non-root user. The only build arguments are two non-secret frontend values, `VITE_HOST_SLEEPS` and `VITE_BASEMAP_STYLE`; empty or unset means the default, so a plain `docker build` makes the same app as a local build. The base images (`node:22-slim`, `python:3.13-slim` and the `uv` image) are pinned by digest, each beside its tag. The image measured 430 MB uncompressed as `docker images` reports it, and about 89 MB as a gzip of `docker save`.
- **`.dockerignore`** keeps every `.env` out of the build context, so a `COPY` cannot bake one in. The provider keys and the Django secret reach the container only as run-time environment values.
- **One origin, fixed paths.** `config/static.py` wraps the Django application in `config/asgi.py`. It answers `/` (`index.html`, `no-cache`, so a redeploy never leaves a browser on an entry that points at deleted chunks) and `/assets/*` (hashed files, cacheable for a year; `.js` and `.mjs` are served as `text/javascript`, which the map's module worker needs). Everything else, including every `/api/` path and the ASGI lifespan, goes to Django untouched. The app has one page and no client-side router, so there is no catch-all route. The API is mounted at `/api/` with no prefix, so the error middleware's `request.path` check holds as deployed. The build is read into memory at start-up (about 2.3 MB), so a request cannot name a file that was not in it.
- **A wrapper, not a middleware.** WhiteNoise's Django middleware (6.12) is synchronous only, and a sync-only middleware makes Django run every API request through a thread, while the forecast cache is only safe on the event loop.
- **One process.** The start command runs one uvicorn worker. The forecast cache and the weather runtime are per process, so a second worker would split them.
- **Proxy trust has one owner.** `DJANGO_TRUST_PROXY_SSL=1` (set in the image) makes Django read `X-Forwarded-Proto`; uvicorn's own forwarded-header handling is off (`--no-proxy-headers`). With no cookies, sessions or redirects the only effect is `request.is_secure()`. There is no in-app HTTPS redirect: the host's edge does that, and a redirect in the container would fail a plain-HTTP health check.

## Render configuration

- **`render.yaml`** describes the service: Docker runtime, health check on `/api/health`, and auto-deploy off, expected to mean a push never deploys by itself (whether `autoDeployTrigger: "off"` is the right blueprint key and value is not verified). The provider keys and the hostname are named there and set in the dashboard, never in the repository or the image.
- **Allowed hosts.** `DJANGO_ALLOWED_HOSTS` is the only source. On Render it holds the service's hostname and `localhost`, comma-separated, because Render's port and health checker calls with Host `localhost`. That Host value is inferred, not observed: with the hostname alone, deploys failed with "Port scan timeout reached", with `localhost` added they succeeded, and a [Render community report](https://community.render.com/t/health-check-invalid-http-host-header-localhost-10000/4438) describes the same. In a local `docker run` the value is `localhost`. A request for the hosted page with any other Host is refused at Cloudflare's edge with a 403 before it reaches the app; the app's own 400 is what a local container shows.

## Wake copy

Render documents that a free service sleeps after 15 minutes idle and that the first request afterwards waits about a minute while it wakes ([measured wake](performance.md#hosted-render-free-plan-2026-11-14)). A fresh visit pays that wait for the page itself, before any app code exists, so no in-app text can cover it; the README says so.

The in-app copy covers a tab that stayed open while the host went back to sleep. In a build with `VITE_HOST_SLEEPS=1`, an address search still pending after 10 s says "Still searching. The server may be waking up after being idle. That can take up to a minute.", and a routes request still pending after 20 s adds "The server may be waking up after being idle. That can take up to a minute." The thresholds sit above the longest warm waits measured on the host. The weather wait cannot be the first request, so it carries none.

`render.yaml` sets `VITE_HOST_SLEEPS` as a service environment value and the Dockerfile reads it as a build argument. The copy is present in the served bundle, which suggests Render passes the value to the image build. Local builds, tests and `make check` never set it.

## Logs

The app writes its own log lines to the console (the `LOGGING` setting in `config/base.py`: one handler on the root logger at INFO, which Django's loggers use too). The `httpx` and `httpcore` loggers are held at WARNING, because httpx logs every request URL, key included, at INFO.

| Line | Level | When |
|---|---|---|
| `weather: N locations, M cached` | INFO | every weather request |
| `weather: refused, waiting N s` | INFO | each rate-limit wait |
| `weather: parsing a chunk failed: <error type>` | WARNING | a received chunk that could not be parsed |
| `weather: deadline passed after 150 s` | WARNING | the weather deadline passes |
| `provider call timed out: host=…, kind=…, attempts=…, elapsed=… s` | WARNING | a call that ends in a timeout after its retry |
| `provider call failed: host=…, kind=…, attempts=…, elapsed=… s` | WARNING | a call that ends refused or unresolvable after its tries |
| `via-city <city>: overlap <share> with the routes in hand` | INFO | each via-city route measured during a routes request |
| `via-city route failed: <error type>` | WARNING | a via-city call that failed |
| `API answered <status> without an error body` | WARNING | the error middleware replaced a body |
| `unhandled error in <path>` | ERROR | an unexpected exception, with its traceback |

In the provider lines, `kind` is the error type (`ReadTimeout`, `ConnectTimeout`, `ConnectError`, …), `attempts` counts every try, connect tries included (an Open-Meteo call that never connected shows `attempts=4`), and `elapsed` runs from the call's first slot (time queued for a slot is not counted). Together the weather lines tell a weather 504 apart: one slow or unreachable Open-Meteo call, or a deadline spent on rate-limit waits. The hosted log has shown `provider call timed out` with `ConnectTimeout` after 20 s (2026-11-15, under a connect policy of one 10 s try and one retry).

The app's own lines carry no provider URL, key or coordinate. uvicorn's access log is on, and it records each request's path with its query, so the text typed into an address search appears there.

## Hosting choices

Each rests on the hosted measurements in [performance.md](performance.md#hosted-render-free-plan-2026-11-14):

- **Open-Meteo on the free plan, with no paid key.** The hosted runs showed no 503, though at one time of day only, so this is not a guarantee ([Known limitations](../README.md#known-limitations)).
- **No compression in the app.** Cloudflare's edge compresses the assets and the API answers.
- **The OpenFreeMap Positron basemap.** It drew the plan on the hosted service with no failures; every cell was Low there, so the colour ramp was not judged against it on the host.

**Switching the basemap** is a build-time act: set `VITE_BASEMAP_STYLE` to the style URL and redeploy. The Dockerfile reads it as a build argument of that name, and on Render the service environment value is expected to reach the image build the same way `VITE_HOST_SLEEPS` appears to; `VITE_BASEMAP_STYLE` has not been set on Render, so this is expected, not observed. A Carto style such as `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json` is the named alternative; that URL is untested here. A style other than Positron needs the heatmap's colour ramp and the stop and checkpoint halos re-measured against it first, because they were chosen against Positron's greys ([assumptions.md](assumptions.md#heatmap-and-corridor)).

## API docs page and content policy

- **`/api/docs`** is Ninja's interactive API page. Ninja is not an installed Django app, so it renders its CDN page, Swagger UI loaded from jsDelivr, rather than one that would ask this server for `/static/` files, which nothing serves. The schema it reads (`/api/openapi.json`) comes from the app itself.
- **That script runs with the origin's rights,** because there is no content security policy. That is acceptable here because the origin holds nothing for a script to steal or act with: no cookies, sessions or login, no user content, no stored data, and no provider key in the browser. The CDN files are versioned (`swagger-ui-dist@5`) but not integrity-pinned.
- **No content security policy.** A policy would protect little, and it would need a second place that knows the basemap host: the style URL is baked into the frontend at build time while a policy is a server header. It would have to allow the same-origin worker and scripts, inline styles (Material UI injects them), `data:` and `blob:` images, and connections to the basemap host for style, tiles, glyphs and sprites.
