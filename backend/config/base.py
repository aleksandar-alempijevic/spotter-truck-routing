"""Django settings, read from environment variables (no `.env` handling here).

Debug is off unless DJANGO_DEBUG is set, so an unconfigured deployment is safe by
default; with debug off, DJANGO_SECRET_KEY is required.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


DEBUG = env_bool("DJANGO_DEBUG", False)

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise RuntimeError("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is off.")
    SECRET_KEY = "insecure-local-development-key"

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")

# Behind a TLS-terminating proxy (Render's edge), the request reaches the container as plain
# HTTP with `X-Forwarded-Proto` set. Set DJANGO_TRUST_PROXY_SSL there so Django reads it. The
# trust lives only here: the server is started with uvicorn's own forwarded-header handling off.
# Do not set it where the container is reachable without the proxy, since a client could then
# claim HTTPS.
if env_bool("DJANGO_TRUST_PROXY_SSL", False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# The built frontend that `config.asgi` serves at `/` and `/assets/*`. The default is where
# `pnpm -C frontend build` writes it; the image sets nothing because it copies it to the same
# place. A missing build is tolerated (tests and `make backend` never build it).
FRONTEND_DIST_DIR = Path(
    os.environ.get("FRONTEND_DIST_DIR") or BASE_DIR.parent / "frontend" / "dist"
)

# Lean on purpose: no database (Django's default is none), sessions, auth or admin;
# the core flow is stateless.
# `ninja` is listed only so the API docs at /api/docs can find their template.
INSTALLED_APPS = ["ninja"]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "api.middleware.ApiErrorBodies",
]

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "APP_DIRS": True,
    }
]

ROOT_URLCONF = "config.urls"
ASGI_APPLICATION = "config.asgi.application"

# Provider keys. Optional at start-up: a missing key is a clear API error when a request needs it.
TOMTOM_API_KEY = os.environ.get("TOMTOM_API_KEY", "")
GEOAPIFY_API_KEY = os.environ.get("GEOAPIFY_API_KEY", "")

# The providers take their API keys in the query string, and httpx logs every request URL at INFO.
# Keep its loggers quiet so a key can never reach a log line, whatever the root level is.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "loggers": {
        "httpx": {"level": "WARNING"},
        "httpcore": {"level": "WARNING"},
    },
}
