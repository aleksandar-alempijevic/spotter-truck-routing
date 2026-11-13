"""The weather use case: forecasts for the routes' checkpoints and the corridor grid, risk levels,
route summaries and the ranking.

Decisions live in `weather` and `risk_rules`; this module sequences the awaits, owns the
forecast cache and the wait policy, and is the only place that builds a `WeatherReading`.
"""

import asyncio
import logging
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from providers import MAX_LOCATIONS_PER_CALL, Outbound, ProviderTimeout, fetch_forecasts, openmeteo
from providers.errors import ProviderRateLimited
from risk_rules import (
    FLOAT_MARGIN,
    Checkpoint,
    Classification,
    Level,
    RankedRoute,
    RouteCandidate,
    RouteSummary,
    WeatherReading,
    classify_weather,
    rank_routes,
    summarize_route,
)
from weather import (
    Cell,
    Conditions,
    ForecastCache,
    ForecastSeries,
    LocationPlan,
    cell_center,
    conditions_at,
    forecast_cell,
    plan_locations,
)
from weather.grid import DISPLAY_DEGREES

from .schemas import RouteCore

logger = logging.getLogger(__name__)

BUDGET_S = 150.0
"""One deadline for the whole request: two full waits on the minute window plus the calls."""
MAX_LOCATIONS = 1800
"""The most forecast locations one request may need: three windows of 600, which is what fits the
deadline. It also bounds the grid."""
MAX_CACHED_LOCATIONS = 3000
"""Cache ceiling in forecast cells: room for one largest request, a few megabytes per thousand."""

WINDOW_S = 60.0
"""Open-Meteo's rate-limit window."""
MAX_RETRY_DELAY_S = WINDOW_S + 2.0
"""A refusal is waited out only when its stated delay is at most one window and a small pad."""
RETRY_PAD_S = 1.0
MAX_REFUSALS_PER_CHUNK = 3

GRID_HOURS = 49
"""The slider's hours, from 0 (the top of the request's UTC hour) to 48."""
LEVEL_CODES = list(Level)
"""Grid levels are indexes into this list: low, moderate, high, severe, no_travel."""

CACHE = ForecastCache(MAX_CACHED_LOCATIONS)
"""The process's forecast cache; touched only on the event loop."""


class WeatherRequestTooLarge(Exception):
    """The routes need more forecast locations than a request may spend."""


def _now() -> datetime:
    return datetime.now(UTC)


def _monotonic() -> float:
    return asyncio.get_running_loop().time()


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def build_report(
    routes: Sequence[RouteCore], *, load_lb: float, spacing_miles: int
) -> dict[str, Any]:
    """The weather response body for routes already validated against `WeatherIn`.

    A result is complete or an error: a provider failure, a refusal that cannot be waited out or
    a passed deadline fails the request, and what was fetched stays cached for the retry.
    """
    hour = _now().replace(minute=0, second=0, microsecond=0)
    deadline = _monotonic() + BUDGET_S

    positions = [[(c.lat, c.lon) for c in route.checkpoints] for route in routes]
    plan = await asyncio.to_thread(plan_locations, positions)
    if len(plan.cells) > MAX_LOCATIONS:
        raise WeatherRequestTooLarge

    series_by_cell: dict[Cell, ForecastSeries] = {}
    missing = []
    for cell in plan.cells:
        cached = CACHE.get(cell, hour)
        if cached is None:
            missing.append(cell)
        else:
            series_by_cell[cell] = cached
    logger.info("weather: %d locations, %d cached", len(plan.cells), len(series_by_cell))
    if missing:
        series_by_cell |= await _fetch(missing, deadline)

    body = await asyncio.to_thread(
        _assemble, routes, plan, series_by_cell, hour, load_lb, spacing_miles
    )
    body["attribution"] = {"text": openmeteo.ATTRIBUTION_TEXT, "url": openmeteo.ATTRIBUTION_URL}
    return body


async def _fetch(cells: list[Cell], deadline: float) -> dict[Cell, ForecastSeries]:
    """Fetch the cells in chunks, all at once under the outbound cap, caching each chunk as it
    arrives."""
    fetched: dict[Cell, ForecastSeries] = {}
    chunks = [
        cells[i : i + MAX_LOCATIONS_PER_CALL] for i in range(0, len(cells), MAX_LOCATIONS_PER_CALL)
    ]

    async def one(outbound: Outbound, chunk: list[Cell]) -> None:
        series = await _fetch_chunk(outbound, chunk, deadline)
        for cell, one_series in zip(chunk, series, strict=True):
            CACHE.put(cell, one_series)
            fetched[cell] = one_series

    try:
        async with asyncio.timeout(max(0.0, deadline - _monotonic())):
            async with Outbound() as outbound:
                tasks = [asyncio.ensure_future(one(outbound, chunk)) for chunk in chunks]
                try:
                    await asyncio.gather(*tasks)
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
    except TimeoutError:
        raise ProviderTimeout from None
    return fetched


async def _fetch_chunk(
    outbound: Outbound, chunk: list[Cell], deadline: float
) -> list[ForecastSeries]:
    """One chunk's series, waiting out a refusal when the wait is short and fits the deadline.

    The wait happens here, after the call has released its outbound slot, so other chunks keep
    their turn. Every other refusal is raised at once.
    """
    points = [cell_center(cell) for cell in chunk]
    refusals = 0
    while True:
        try:
            return await fetch_forecasts(outbound, points)
        except ProviderRateLimited as refused:
            refusals += 1
            wait = _wait_for(refused.retry_after_s, deadline)
            if wait is None or refusals > MAX_REFUSALS_PER_CHUNK:
                raise
            logger.info("weather: refused, waiting %.0f s", wait)
            await _sleep(wait)


def _wait_for(delay_s: float | None, deadline: float) -> float | None:
    """Seconds to wait before retrying a refusal, or None when it must be raised instead."""
    if delay_s is None or delay_s > MAX_RETRY_DELAY_S:
        return None
    wait = delay_s + RETRY_PAD_S
    return wait if _monotonic() + wait < deadline else None


def _assemble(
    routes: Sequence[RouteCore],
    plan: LocationPlan,
    series_by_cell: dict[Cell, ForecastSeries],
    hour: datetime,
    load_lb: float,
    spacing_miles: int,
) -> dict[str, Any]:
    """Everything after the fetch: pure computation, run in a thread."""

    def classify(conditions: Conditions | None) -> Classification | None:
        if conditions is None:
            return None
        reading = WeatherReading(
            conditions.wind_mph, conditions.rain_in_per_hr, conditions.snow_in_per_hr
        )
        return classify_weather(reading, load_lb)

    route_bodies, candidates = [], []
    for route in routes:
        checkpoints, levels = [], []
        for checkpoint in route.checkpoints:
            series = series_by_cell[forecast_cell((checkpoint.lat, checkpoint.lon))]
            conditions = conditions_at(series, checkpoint.eta)
            risk = classify(conditions)
            checkpoints.append({"mile": checkpoint.mile, "weather": conditions, "risk": risk})
            levels.append(Checkpoint(checkpoint.mile, risk.level if risk else None))
        summary = summarize_route(route.total_miles, levels)
        route_bodies.append({"id": route.id, "checkpoints": checkpoints, "summary": summary})
        candidates.append(RouteCandidate(route.id, route.travel_time_seconds, summary))

    cells = []
    for grid_cell in plan.grid:
        series = series_by_cell[grid_cell.forecast]
        codes = []
        for h in range(GRID_HOURS):
            risk = classify(conditions_at(series, hour + timedelta(hours=h)))
            codes.append(None if risk is None else risk.level.score)
        cells.append({"lat": grid_cell.lat, "lon": grid_cell.lon, "levels": codes})

    return {
        "plan": {"load_lb": load_lb, "checkpoint_interval_miles": spacing_miles},
        "departure": min(route.checkpoints[0].eta for route in routes),
        "routes": route_bodies,
        "ranking": _ranking(candidates, spacing_miles),
        "grid": {
            "start": hour,
            "cell_degrees": DISPLAY_DEGREES,
            "level_codes": LEVEL_CODES,
            "cells": cells,
        },
    }


def _ranking(candidates: list[RouteCandidate], spacing_miles: int) -> dict[str, Any]:
    if len(candidates) > 1:
        ranking = rank_routes(candidates, spacing_miles)
        return {
            "recommended_id": ranking.recommended_id,
            "decided_by": ranking.decided_by,
            "routes": ranking.routes,
        }
    return single_route_ranking(candidates[0], spacing_miles)


def single_route_ranking(candidate: RouteCandidate, spacing_miles: int) -> dict[str, Any]:
    """The ranking of a one-route plan, which `rank_routes` does not take: the route is first,
    and recommended unless it has No Travel miles, judged with the margin `rank_routes` uses."""
    summary: RouteSummary = candidate.summary
    tolerance = (
        None if summary.average_risk is None else min(1.0, spacing_miles / summary.forecast_miles)
    )
    only = RankedRoute(candidate.route_id, 1, summary.no_forecast_miles, tolerance, None)
    recommended = candidate.route_id if summary.no_travel_miles <= FLOAT_MARGIN else None
    return {"recommended_id": recommended, "decided_by": None, "routes": [only]}
