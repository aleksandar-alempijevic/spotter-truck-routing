"""Live check of GET /api/address-search against Geoapify. Not part of `make check` or pytest:
it spends real Geoapify calls.

    uv --directory backend run python live_address_check.py OUTPUT.json

Reads the key from the repository's `.env` through the app's own settings and never prints it or
a request URL. It stops before exceeding MAX_CALLS calls.
"""

import asyncio
import json
import os
import sys
import time

os.environ.setdefault("DJANGO_DEBUG", "1")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402

django.setup()

from django.test import AsyncClient  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from providers.outbound import Outbound  # noqa: E402

MAX_CALLS = 10
QUERIES = [
    "Dallas",
    "Spring",
    "Portland",
    "1600 Pennsylvania Ave NW, Washington, DC",
    "1600 Pennsylvania Ave, Washington",
    "123 Main St, Springfield, IL",
    "Kladovo",
    "Amarillo, TX",
]

raw_results: list[dict] = []
real_get_json = Outbound.get_json


async def recording_get_json(self, url, params, **kwargs):
    if len(raw_results) >= MAX_CALLS:
        raise RuntimeError("Geoapify call budget reached")
    record: dict = {}
    raw_results.append(record)
    body = await real_get_json(self, url, params, **kwargs)
    results = body.get("results", [])
    record["raw_results"] = len(results)
    record["with_timezone"] = sum(1 for r in results if r.get("timezone"))
    record["timezone_shapes"] = sorted({type(r.get("timezone")).__name__ for r in results})
    record["result_types"] = [r.get("result_type") for r in results]
    record["country_codes"] = sorted({str(r.get("country_code")) for r in results})
    return body


async def main(output: str) -> None:
    Outbound.get_json = recording_get_json
    setup_test_environment()
    client = AsyncClient()
    results = {}
    for query in QUERIES:
        started = time.monotonic()
        response = await client.get("/api/address-search", {"q": query})
        seconds = round(time.monotonic() - started, 2)
        body = response.json()
        entry = {"status": response.status_code, "seconds": seconds, **raw_results[-1]}
        if response.status_code == 200:
            entry["suggestions"] = [
                {"label": s["label"], "timezone": s["timezone"]} for s in body["suggestions"]
            ]
            entry["attribution"] = body["attribution"]
        else:
            entry["error_code"] = body.get("code")
        results[query] = entry
    summary = {"geoapify_calls_total": len(raw_results), "queries": results}
    with open(output, "w") as out:
        json.dump(summary, out, indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
