"""Live check of POST /api/weather, end to end: one real cross-country trip routed by TomTom,
its routes sent back to the weather endpoint, then the same request again. Not part of
`make check` or pytest: it spends real provider calls.

    uv --directory backend run python live_weather_report_check.py OUTPUT.json

Reads the TomTom key from the repository's `.env` through the app's own settings and never prints
it or a request URL. It stops before exceeding MAX_TOMTOM_CALLS TomTom calls and MAX_LOCATIONS
Open-Meteo locations (counted per location). The repeat must fetch nothing: when the two requests
straddle a UTC hour the repeat counts as cold and the output says so.
"""

import asyncio
import json
import sys
import time
from datetime import UTC, datetime, timedelta

from live_common import LocationMeter, plan_stats, record_calls, start_django, write_summary

start_django()

from django.test import AsyncClient  # noqa: E402

from api import api as api_module  # noqa: E402
from api import weather_report  # noqa: E402
from routing.via_cities import CITIES  # noqa: E402
from weather import plan_locations, utc_hour  # noqa: E402

MAX_TOMTOM_CALLS = 5
MAX_LOCATIONS = 1500
ORIGIN, DESTINATION = "Seattle", "Miami"
SPACING_MILES = 25
LOAD_LB = 80_000


async def post(client: AsyncClient, path: str, body: dict) -> tuple[dict, float, int, int]:
    started = time.monotonic()
    response = await client.post(path, data=json.dumps(body), content_type="application/json")
    seconds = round(time.monotonic() - started, 2)
    return response.json(), seconds, len(response.content), response.status_code


def describe(weather: dict) -> dict:
    return {
        "ranking": {
            "recommended_id": weather["ranking"]["recommended_id"],
            "decided_by": weather["ranking"]["decided_by"],
            "order": [r["id"] for r in weather["ranking"]["routes"]],
        },
        "routes": {
            r["id"]: {
                "checkpoints": len(r["checkpoints"]),
                "no_forecast_checkpoints": sum(c["risk"] is None for c in r["checkpoints"]),
                **{k: round(v, 2) for k, v in r["summary"].items() if v is not None},
            }
            for r in weather["routes"]
        },
        "grid_cells": len(weather["grid"]["cells"]),
        "grid_start": weather["grid"]["start"],
    }


async def main(output: str) -> None:
    tomtom = record_calls(MAX_TOMTOM_CALLS, label=lambda url: {"kind": "tomtom"})
    waits: list[float] = []

    async def recording_sleep(seconds: float) -> None:
        waits.append(seconds)
        await asyncio.sleep(seconds)

    runtime = weather_report.default_runtime()
    runtime.sleep = recording_sleep
    api_module.WEATHER_RUNTIME = runtime  # the endpoint's one wiring point

    client = AsyncClient()
    origin, destination = CITIES[ORIGIN], CITIES[DESTINATION]
    routes, routes_s, routes_bytes, routes_status = await post(
        client,
        "/api/routes",
        {
            "origin": {"lat": origin[0], "lon": origin[1]},
            "destination": {"lat": destination[0], "lon": destination[1]},
            "departure": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
            "load_lb": LOAD_LB,
            "checkpoint_interval_miles": SPACING_MILES,
        },
    )
    summary: dict = {
        "trip": f"{ORIGIN}-{DESTINATION}",
        "spacing_miles": SPACING_MILES,
        "load_lb": LOAD_LB,
        "routes_request": {"status": routes_status, "seconds": routes_s, "bytes": routes_bytes},
        "tomtom_calls": len(tomtom),
    }
    if routes_status != 200:
        write_summary(output, {**summary, "error": routes.get("code")})
        return

    positions = [[(c["lat"], c["lon"]) for c in r["checkpoints"]] for r in routes["routes"]]
    summary["plan"] = {
        "routes": len(positions),
        "checkpoints": sum(len(p) for p in positions),
        **plan_stats(plan_locations(positions)),
    }

    runs, bodies = {}, {}
    with LocationMeter(MAX_LOCATIONS) as meter:
        for name in ("cold", "repeat"):
            meter.phase = name
            spent_before, requests_before = meter.spent, len(meter.records)
            hour = utc_hour(runtime.now())
            body, seconds, size, status = await post(client, "/api/weather", routes)
            runs[name] = {
                "status": status,
                "seconds": seconds,
                "bytes": size,
                "locations_fetched": meter.spent - spent_before,
                "open_meteo_requests": meter.records[requests_before:],
                "waits_s": list(waits),
                "hour": hour.isoformat(),
                **(describe(body) if status == 200 else {"error": body.get("code")}),
            }
            bodies[name] = body
            waits.clear()
            if status != 200:
                break
        summary["open_meteo_locations"] = meter.spent
    if len(runs) == 2 and all(run["status"] == 200 for run in runs.values()):
        runs["repeat"]["identical_to_cold"] = bodies["repeat"] == bodies["cold"]
        runs["repeat"]["straddled_the_hour"] = runs["repeat"]["hour"] != runs["cold"]["hour"]
    write_summary(
        output, {**summary, "weather": runs, "tomtom_calls": len(tomtom), "tomtom": tomtom}
    )


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
