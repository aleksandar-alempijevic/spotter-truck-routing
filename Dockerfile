# One image: Django on uvicorn serving the API and the built frontend from one origin.
# Build:  docker build -t spotter-truck-routing .
# Run:    docker run -e DJANGO_SECRET_KEY=... -e DJANGO_ALLOWED_HOSTS=localhost -e PORT=8000 -p 8000:8000 spotter-truck-routing
# No secret is a build argument or is copied in: keys and the Django secret arrive as run-time
# environment values only (.dockerignore keeps every .env out of the build context).

# Stage 1: build the frontend. Node 22 satisfies the "engines" range in frontend/package.json;
# corepack installs the pnpm version pinned in "packageManager".
FROM node:22-slim AS frontend
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /build/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# Stage 2: the runtime. Only the backend packages and the built frontend are copied: no tests,
# no live-check scripts, no spikes, no dev dependencies.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv
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
