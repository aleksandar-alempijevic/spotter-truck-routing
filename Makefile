# The one place that defines how to run things. See README.md.
.PHONY: install backend frontend test check types types-check

# Frontend API types are generated from the backend's OpenAPI schema. The schema is exported under
# the test settings, which read no .env and need no secrets. Scratch files live in node_modules
# (git-ignored) and are overwritten on every run.
API_TYPES := frontend/src/api/schema.d.ts
SCRATCH := $(CURDIR)/frontend/node_modules/.tmp/api-types

# $(call generate_types,OUTPUT_FILE): export the schema, then generate TypeScript from it.
define generate_types
mkdir -p $(SCRATCH)
DJANGO_SETTINGS_MODULE=config.settings_test uv --directory backend run python manage.py export_openapi_schema --api api.api.api --output $(SCRATCH)/openapi.json
pnpm -C frontend exec openapi-typescript $(SCRATCH)/openapi.json -o $(1)
endef

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

types:
	$(call generate_types,$(CURDIR)/$(API_TYPES))

# Fails when the committed types differ from a fresh generation (compared on disk, not in git).
types-check:
	$(call generate_types,$(SCRATCH)/schema.fresh.d.ts)
	diff $(API_TYPES) $(SCRATCH)/schema.fresh.d.ts || { echo "$(API_TYPES) is stale: run 'make types'"; exit 1; }

check: test types-check
	uv --directory backend run ruff check .
	uv --directory backend run ruff format --check .
	pnpm -C frontend typecheck
	pnpm -C frontend lint
	pnpm -C frontend format:check
