"""Measures what a trip costs Open-Meteo's free quota, offline and live. Not part of `make check`
or pytest: the live part spends real Open-Meteo locations (no key, no TomTom call).

    uv --directory backend run python live_weather_check.py OUTPUT.json [--offline]

Offline: how many forecast locations the corridor plan needs per checkpoint spacing, for
synthetic route sets between the seven test trips' cities (a straight line plus up to two via-city
routes, with miles stretched by ROAD_FACTOR so checkpoint counts match real road miles).

Live (skipped with --offline), at most MAX_LOCATIONS locations in all, counted per location and
never per call (a retry counts again; a call that would pass the budget is not sent):
  1. one chunk of 150 alone: latency and the billed cost;
  2. four chunks of 150 in flight together (600 locations) after the minute window has reset;
  3. one more chunk straight after, past 600 locations in that minute: whether it is refused and
     what `Retry-After` says, then one chunk after waiting that long;
  4. four chunks in flight again after a reset, for a second latency sample.

Nothing here records a request URL.
"""

import asyncio
import sys
import time
from datetime import UTC, datetime
from typing import Any

from live_common import LocationMeter, chunked, plan_stats, write_summary
from providers import MAX_LOCATIONS_PER_CALL, Outbound, fetch_forecasts
from providers.errors import ProviderError
from providers.openmeteo import FORECAST_HOURS
from routing import build_checkpoints
from routing.via_cities import CITIES, via_candidates
from tests.route_fixtures import route_from
from weather import cell_center, plan_locations

MAX_LOCATIONS = 2000
WINDOW_WAIT_S = 65
ROAD_FACTOR = 1.2
"""Road miles over straight-line miles on a cross-country trip (the straight line misses bends)."""
SPACINGS = (10, 25, 50)
TRIPS = [
    ("Los Angeles", "New York"),
    ("Seattle", "Miami"),
    ("Chicago", "Los Angeles"),
    ("Dallas", "San Francisco"),
    ("Denver", "Atlanta"),
    ("Chicago", "Indianapolis"),
    ("Dallas", "Houston"),
]
DEPARTURE = datetime(2026, 11, 13, 8, 0, tzinfo=UTC)


def route_sets() -> dict[str, list]:
    sets = {}
    for origin_name, destination_name in TRIPS:
        origin, destination = CITIES[origin_name], CITIES[destination_name]
        routes = [route_from([origin, destination])]
        vias = via_candidates(origin, destination, [list(routes[0].points)])[:2]
        routes += [route_from([origin, (via.lat, via.lon), destination]) for via in vias]
        sets[f"{origin_name}-{destination_name}"] = routes
    return sets


def offline(sets: dict[str, list]) -> tuple[list[dict[str, Any]], dict[int, list]]:
    rows, cells_by_spacing = [], {spacing: [] for spacing in SPACINGS}
    for name, routes in sets.items():
        for spacing in SPACINGS:
            positions = [
                [
                    (cp.lat, cp.lon)
                    for cp in build_checkpoints(route, spacing / ROAD_FACTOR, DEPARTURE)
                ]
                for route in routes
            ]
            plan = plan_locations(positions)
            cells_by_spacing[spacing] += [
                c for c in plan.cells if c not in cells_by_spacing[spacing]
            ]
            rows.append(
                {
                    "trip": name,
                    "routes": len(routes),
                    "spacing_miles": spacing,
                    "road_miles": [round(r.total_miles * ROAD_FACTOR) for r in routes],
                    "checkpoints": sum(len(p) for p in positions),
                    **plan_stats(plan),
                }
            )
    return rows, cells_by_spacing


async def chunk(outbound: Outbound, cells: list) -> dict[str, Any]:
    started = time.monotonic()
    try:
        series = await fetch_forecasts(outbound, [cell_center(c) for c in cells])
    except ProviderError as error:
        return {
            "error": type(error).__name__,
            "retry_after_s": getattr(error, "retry_after_s", None),
            "seconds": round(time.monotonic() - started, 2),
        }
    return {
        "series": len(series),
        "hours": sorted({len(s.wind_mph) for s in series}),
        "first_stamp": series[0].start.isoformat(),
        "absent_values": sum(v is None for s in series for v in s.wind_mph + s.gust_mph),
        "seconds": round(time.monotonic() - started, 2),
    }


async def four_in_flight(outbound: Outbound, chunks: list) -> dict[str, Any]:
    """Four chunks at once (the app's cap), with the wall time of the wave."""
    started = time.monotonic()
    results = await asyncio.gather(*(chunk(outbound, c) for c in chunks))
    return {"chunks": results, "wall_s": round(time.monotonic() - started, 2)}


async def live(cells: list) -> dict[str, Any]:
    chunks = chunked(cells)
    assert len(chunks) >= 11 and all(len(c) == MAX_LOCATIONS_PER_CALL for c in chunks[:11])
    result: dict[str, Any] = {}
    with LocationMeter(MAX_LOCATIONS) as meter:
        async with Outbound() as outbound:
            meter.phase = "1 single chunk"
            result["single"] = await chunk(outbound, chunks[0])

            await asyncio.sleep(WINDOW_WAIT_S)
            meter.phase = "2 four in flight"
            result["four_in_flight_a"] = await four_in_flight(outbound, chunks[1:5])

            meter.phase = "3 burst past 600 in the minute"
            burst = result["burst"] = await chunk(outbound, chunks[5])
            if "error" in burst:
                wait = burst["retry_after_s"]
                meter.phase = "3b after waiting Retry-After"
                await asyncio.sleep((wait if wait is not None else WINDOW_WAIT_S) + 1)
                result["after_wait"] = {"waited_s": wait, **(await chunk(outbound, chunks[6]))}
            else:
                meter.phase = "3b second burst"
                result["second_burst"] = await chunk(outbound, chunks[6])

            await asyncio.sleep(WINDOW_WAIT_S)
            meter.phase = "4 four in flight again"
            result["four_in_flight_b"] = await four_in_flight(outbound, chunks[7:11])
        result["requests"] = meter.records
        result["locations_spent"] = meter.spent
    return result


def main() -> None:
    output = sys.argv[1]
    rows, cells_by_spacing = offline(route_sets())
    summary: dict[str, Any] = {
        "road_factor": ROAD_FACTOR,
        "forecast_hours": FORECAST_HOURS,
        "offline": rows,
        "distinct_cells_over_all_trips": {str(k): len(v) for k, v in cells_by_spacing.items()},
    }
    if "--offline" not in sys.argv:
        summary["live"] = asyncio.run(live(cells_by_spacing[10]))
    write_summary(output, summary)


if __name__ == "__main__":
    main()
