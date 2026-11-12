# The one place that defines how to run things. See README.md.
.PHONY: install backend frontend test check

install:
	uv --directory backend sync
	pnpm -C frontend install

backend:
	DJANGO_DEBUG=1 uv --directory backend run uvicorn config.asgi:application --reload --port 8000

frontend:
	pnpm -C frontend dev

test:
	uv --directory backend run pytest
	pnpm -C frontend test

check: test
	uv --directory backend run ruff check .
	uv --directory backend run ruff format --check .
	pnpm -C frontend typecheck
	pnpm -C frontend lint
	pnpm -C frontend format:check
