"""Live check of GET /api/address-search against Geoapify. Not part of `make check` or pytest:
it spends real Geoapify calls.

    uv --directory backend run python live_address_check.py OUTPUT.json

Reads the key from the repository's `.env` through the app's own settings and never prints it or
a request URL. It stops before exceeding MAX_CALLS calls.
"""

import asyncio
import sys
import time

from live_common import record_calls, start_django, write_summary

start_django()

from django.test import AsyncClient  # noqa: E402

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


def describe_body(body: dict) -> dict:
    results = body.get("results", [])
    return {
        "raw_results": len(results),
        "with_timezone": sum(1 for r in results if r.get("timezone")),
        "timezone_shapes": sorted({type(r.get("timezone")).__name__ for r in results}),
        "result_types": [r.get("result_type") for r in results],
        "country_codes": sorted({str(r.get("country_code")) for r in results}),
    }


async def main(output: str) -> None:
    calls = record_calls(MAX_CALLS, describe=describe_body)
    client = AsyncClient()
    results = {}
    for query in QUERIES:
        started = time.monotonic()
        response = await client.get("/api/address-search", {"q": query})
        body = response.json()
        entry = {
            "status": response.status_code,
            "seconds": round(time.monotonic() - started, 2),
            **calls[-1],
        }
        if response.status_code == 200:
            entry["suggestions"] = [
                {"label": s["label"], "timezone": s["timezone"]} for s in body["suggestions"]
            ]
            entry["attribution"] = body["attribution"]
        else:
            entry["error_code"] = body.get("code")
        results[query] = entry
    write_summary(output, {"geoapify_calls_total": len(calls), "queries": results})


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
