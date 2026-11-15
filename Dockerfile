# One image: Django on uvicorn serving the API and the built frontend from one origin.
# Build:  docker build -t spotter-truck-routing .
# Run:    docker run -e DJANGO_SECRET_KEY=... -e DJANGO_ALLOWED_HOSTS=localhost -e PORT=8000 -p 8000:8000 spotter-truck-routing
# No secret is a build argument or is copied in: keys and the Django secret arrive as run-time
# environment values only (.dockerignore keeps every .env out of the build context).

# Stage 1: build the frontend. Node 22 satisfies the "engines" range in frontend/package.json;
# corepack installs the pnpm version pinned in "packageManager".
# Base images are pinned by digest, each beside its readable tag, so a rebuild cannot move to a
# different image unseen. To update one, resolve the new tag with `docker buildx imagetools
# inspect <tag>` and change the digest with the tag.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS frontend
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /build/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
# The only build-time values, both non-secret and baked into the public page. Empty or unset means
# the frontend's default, so a build without them is the local one: no wake copy, Positron basemap.
# An ARG is visible to the build command as an environment variable, which is how Vite reads it.
#   VITE_HOST_SLEEPS    1 on a host that sleeps when idle: a long wait then says the server may be waking
#   VITE_BASEMAP_STYLE  a basemap style URL other than the default
ARG VITE_HOST_SLEEPS=
ARG VITE_BASEMAP_STYLE=
RUN pnpm build

# Stage 2: the runtime. Only the backend packages and the built frontend are copied: no tests,
# no live-check scripts, no spikes, no dev dependencies.
FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
COPY --from=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/manage.py ./
COPY backend/api ./api
COPY backend/config ./config
COPY backend/providers ./providers
COPY backend/risk_rules ./risk_rules
COPY backend/routing ./routing
COPY backend/weather ./weather
# config/base.py looks for the build at ../frontend/dist, which is here.
COPY --from=frontend /build/frontend/dist /app/frontend/dist
# Compile the app's modules now, as root: the runtime user cannot write __pycache__, and a host
# that sleeps when idle would otherwise recompile them on every wake. The venv is compiled by uv above.
RUN python -m compileall -q /app/backend

RUN useradd --system --no-create-home app
USER app
ENV PATH="/opt/venv/bin:$PATH" DJANGO_TRUST_PROXY_SSL=1
# DJANGO_TRUST_PROXY_SSL: Django alone reads X-Forwarded-Proto (config/base.py); uvicorn's own
# forwarded-header handling is turned off below, so there is one owner. Do not publish the
# container's port to clients without a proxy in front.
EXPOSE 8000

# Exactly one worker process: the forecast cache and the weather runtime are per process.
# `exec` makes uvicorn the container's main process. The host sets PORT (8000 if unset).
CMD ["sh", "-c", "exec uvicorn config.asgi:application --host 0.0.0.0 --port ${PORT:-8000} --no-proxy-headers --workers 1"]
