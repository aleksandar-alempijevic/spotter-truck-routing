"""Live check of POST /api/routes against TomTom, over the seven test trips of the feasibility
spike. Not part of `make check` or pytest: it spends real TomTom calls.

    uv --directory backend run python live_check.py OUTPUT.json [ORIGIN-DESTINATION ...]

With trip names (for example "Chicago-Los Angeles") only those trips run, with no probe.

Reads the key from the repository's `.env` through the app's own settings and never prints it or
a request URL. It stops before exceeding MAX_CALLS TomTom calls, and ends with one extra call on
an unroutable pair to record how TomTom reports it.
"""

import asyncio
import json
import logging
import os
import sys
import time
from datetime import UTC, datetime, timedelta

os.environ.setdefault("DJANGO_DEBUG", "1")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402

django.setup()

from django.test import AsyncClient  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from providers.outbound import Outbound, UpstreamBadRequest  # noqa: E402
from routing import CITIES  # noqa: E402

MAX_CALLS = 25
TRIPS = [
    ("Los Angeles", "New York"),
    ("Seattle", "Miami"),
    ("Chicago", "Los Angeles"),
    ("Dallas", "San Francisco"),
    ("Denver", "Atlanta"),
    ("Chicago", "Indianapolis"),
    ("Dallas", "Houston"),
]
UNROUTABLE_ORIGIN = (30.0, -60.0)  # open Atlantic

calls: list[dict] = []
planner_log: list[str] = []


class PlannerLog(logging.Handler):
    """Collects the planner's per-candidate overlap lines (city names and numbers only)."""

    def emit(self, record: logging.LogRecord) -> None:
        planner_log.append(record.getMessage())


real_get_json = Outbound.get_json


async def counting_get_json(self, url, params, **kwargs):
    if len(calls) >= MAX_CALLS:
        raise RuntimeError("TomTom call budget reached")
    separators = url.split("//", 1)[-1].count(":")  # one per extra waypoint
    record = {"kind": "via" if separators == 2 else "base", "outcome": None}
    calls.append(record)
    started = time.monotonic()
    try:
        body = await real_get_json(self, url, params, **kwargs)
    except UpstreamBadRequest as bad:
        try:
            record["outcome"] = f"400 {bad.body['detailedError']['code']}"
        except (KeyError, TypeError):
            record["outcome"] = "400"
        raise
    except Exception as error:
        record["outcome"] = type(error).__name__
        raise
    finally:
        record["seconds"] = round(time.monotonic() - started, 1)
    record["outcome"] = "ok"
    record["routes"] = [describe(route) for route in body.get("routes", [])]
    return body


def describe(route: dict) -> dict:
    instructions = route["guidance"]["instructions"]
    offsets = [i["routeOffsetInMeters"] for i in instructions]
    times = [i["travelTimeInSeconds"] for i in instructions]
    length = route["summary"]["lengthInMeters"]
    return {
        "legs": len(route["legs"]),
        "points": sum(len(leg["points"]) for leg in route["legs"]),
        "instructions": len(instructions),
        "offsets_monotone": offsets == sorted(offsets),
        "times_monotone": times == sorted(times),
        "last_offset_minus_length_m": offsets[-1] - length,
        "last_time_minus_travel_time_s": times[-1] - route["summary"]["travelTimeInSeconds"],
    }


async def run_trip(client: AsyncClient, origin: tuple, destination: tuple) -> dict:
    departure = datetime.now(UTC) + timedelta(hours=1)
    body = {
        "origin": {"lat": origin[0], "lon": origin[1]},
        "destination": {"lat": destination[0], "lon": destination[1]},
        "departure": departure.isoformat(),
        "load_lb": 80_000,
        "checkpoint_interval_miles": 25,
    }
    first_call = len(calls)
    first_log = len(planner_log)
    started = time.monotonic()
    response = await client.post(
        "/api/routes", data=json.dumps(body), content_type="application/json"
    )
    seconds = round(time.monotonic() - started, 1)
    result = {
        "status": response.status_code,
        "seconds": seconds,
        "response_kb": round(len(response.content) / 1000),
        "tomtom_calls": calls[first_call:],
        "planner_log": planner_log[first_log:],
    }
    payload = response.json()
    if response.status_code != 200:
        result["error_code"] = payload.get("code")
        return result
    result["shortfall"] = payload["shortfall"]
    result["routes"] = [
        {
            "id": r["id"],
            "source": r["source"],
            "via": r["via"] and r["via"]["name"],
            "miles": round(r["total_miles"]),
            "hours": round(r["travel_time_seconds"] / 3600, 1),
            "checkpoints": len(r["checkpoints"]),
            "line_points": len(r["line"]),
            "last_eta_matches_travel_time": abs(
                (datetime.fromisoformat(r["checkpoints"][-1]["eta"]) - departure).total_seconds()
                - r["travel_time_seconds"]
            )
            < 2,
        }
        for r in payload["routes"]
    ]
    return result


async def main(output: str, only: list[str]) -> None:
    Outbound.get_json = counting_get_json
    planner_logger = logging.getLogger("api.planner")
    planner_logger.setLevel(logging.INFO)
    planner_logger.addHandler(PlannerLog())
    setup_test_environment()
    client = AsyncClient()
    results = {}
    for origin, destination in TRIPS:
        if only and f"{origin}-{destination}" not in only:
            continue
        results[f"{origin} - {destination}"] = await run_trip(
            client, CITIES[origin], CITIES[destination]
        )
    if not only:
        results["unroutable probe (open Atlantic to Los Angeles)"] = await run_trip(
            client, UNROUTABLE_ORIGIN, CITIES["Los Angeles"]
        )
    summary = {"tomtom_calls_total": len(calls), "trips": results}
    with open(output, "w") as out:
        json.dump(summary, out, indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2:]))
