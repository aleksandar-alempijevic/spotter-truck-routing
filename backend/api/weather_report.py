"""The weather use case: forecasts for the routes' checkpoints and the corridor grid, risk levels,
route summaries and the ranking.

Decisions live in `weather` and `risk_rules`; this module sequences the awaits, owns the
forecast cache and the wait policy, and is the only place that builds a `WeatherReading`.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ninja.errors import ValidationError

from providers import MAX_LOCATIONS_PER_CALL, Outbound, ProviderTimeout, openmeteo
from providers.errors import ProviderRateLimited
from risk_rules import (
    Checkpoint,
    Classification,
    Level,
    RouteCandidate,
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
    TooManyLocations,
    cell_center,
    conditions_at,
    conditions_by_hour,
    forecast_cell,
    plan_locations,
    utc_hour,
)
from weather.grid import DISPLAY_DEGREES

from .schemas import RouteCore

logger = logging.getLogger(__name__)

BUDGET_S = 150.0
"""One deadline for the whole request: two full waits on the minute window plus the calls."""
MAX_WINDOWS = 3
"""Rate-limit windows a request may need: what the deadline has room for (two waits)."""
MAX_LOCATIONS = MAX_WINDOWS * openmeteo.LOCATIONS_PER_WINDOW
"""The most forecast locations one request may need. It also bounds the grid's display cells."""
MAX_CACHED_LOCATIONS = 3000
"""Cache ceiling in forecast cells: room for one largest request. Measured with tracemalloc, 1,000
series of 96 hours and four fields take 12.6 MB, so the ceiling holds about 38 MB."""

RETRY_PAD_S = 1.0
MAX_RETRY_DELAY_S = openmeteo.RATE_LIMIT_WINDOW_S + 2.0
"""A refusal is waited out only when its stated delay is at most one window and a small pad."""
MAX_REFUSALS_PER_CHUNK = 3

GRID_HOURS = 49
"""The slider's hours, from 0 (the top of the request's UTC hour) to 48."""
LEVEL_CODES = list(Level)
"""Grid levels are indexes into this list: low, moderate, high, severe, no_travel."""


@dataclass(slots=True)
class Runtime:
    """What the use case reads from outside: the clock, the way to sleep, the forecast cache and
    the limits. Production uses `default_runtime()`; tests hand in their own."""

    now: Callable[[], datetime]
    sleep: Callable[[float], Awaitable[None]]
    cache: ForecastCache
    time: Callable[[], float]
    """The clock the deadline is measured on, in seconds; the event loop's in production."""
    budget_s: float = BUDGET_S
    max_locations: int = MAX_LOCATIONS


def default_runtime() -> Runtime:
    """The real clock and sleep, and a new cache. The process keeps one of these, so its cache is
    shared by every request; it is touched only on the event loop."""
    return Runtime(
        now=lambda: datetime.now(UTC),
        sleep=asyncio.sleep,
        cache=ForecastCache(MAX_CACHED_LOCATIONS),
        time=lambda: asyncio.get_running_loop().time(),
    )


async def build_report(
    routes: Sequence[RouteCore], *, load_lb: float, spacing_miles: int, runtime: Runtime
) -> dict[str, Any]:
    """The weather response body for routes already validated against `WeatherIn`.

    A result is complete or an error: a provider failure, a refusal that cannot be waited out or
    a passed deadline fails the request, and what was fetched stays cached for the retry.
    """
    hour = utc_hour(runtime.now())
    deadline = runtime.time() + runtime.budget_s

    positions = [[(c.lat, c.lon) for c in route.checkpoints] for route in routes]
    try:
        plan = await asyncio.to_thread(
            plan_locations, positions, max_locations=runtime.max_locations
        )
    except TooManyLocations:
        plan = None
    if plan is None or len(plan.cells) > runtime.max_locations:
        raise ValidationError(
            [
                {
                    "loc": ("body", "routes"),
                    "msg": f"these routes need more than {runtime.max_locations} "
                    "forecast locations; use a larger checkpoint interval or shorter routes",
                }
            ]
        )

    series_by_cell: dict[Cell, ForecastSeries] = {}
    missing = []
    for cell in plan.cells:
        cached = runtime.cache.get(cell, hour)
        if cached is None:
            missing.append(cell)
        else:
            series_by_cell[cell] = cached
    logger.info("weather: %d locations, %d cached", len(plan.cells), len(series_by_cell))
    if missing:
        series_by_cell |= await _fetch(missing, deadline, runtime)

    body = await asyncio.to_thread(
        _assemble, routes, plan, series_by_cell, hour, load_lb, spacing_miles
    )
    body["attribution"] = {"text": openmeteo.ATTRIBUTION_TEXT, "url": openmeteo.ATTRIBUTION_URL}
    return body


async def _fetch(
    cells: list[Cell], deadline: float, runtime: Runtime
) -> dict[Cell, ForecastSeries]:
    """Fetch the cells in chunks, all at once under the outbound cap, caching each chunk as it
    arrives.

    When one chunk fails the others' unfinished calls are cancelled, but a chunk whose response
    has already arrived is still parsed and cached, so a retry fetches only what is missing.
    """
    fetched: dict[Cell, ForecastSeries] = {}
    chunks = [
        cells[i : i + MAX_LOCATIONS_PER_CALL] for i in range(0, len(cells), MAX_LOCATIONS_PER_CALL)
    ]

    async def store(chunk: list[Cell], raw: list[Any]) -> None:
        series = await asyncio.to_thread(openmeteo.parse_forecasts, raw)
        for cell, one_series in zip(chunk, series, strict=True):
            runtime.cache.put(cell, one_series)
            fetched[cell] = one_series

    async def one(outbound: Outbound, chunk: list[Cell]) -> None:
        raw = await _request_chunk(outbound, chunk, deadline, runtime)
        # Its own task, so cancelling this chunk after its response arrived does not stop it.
        storing = asyncio.ensure_future(store(chunk, raw))
        storing.add_done_callback(_consume)
        await asyncio.shield(storing)

    try:
        async with asyncio.timeout(max(0.0, deadline - runtime.time())):
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


def _consume(task: asyncio.Future[None]) -> None:
    """Mark a finished task's outcome as seen, so one whose request already failed is not
    reported as never retrieved."""
    if not task.cancelled():
        task.exception()


async def _request_chunk(
    outbound: Outbound, chunk: list[Cell], deadline: float, runtime: Runtime
) -> list[Any]:
    """One chunk's raw answers, waiting out a refusal when the wait is short and fits the deadline.

    The wait happens here, after the call has released its outbound slot, so other chunks keep
    their turn. Every other refusal is raised at once.
    """
    points = [cell_center(cell) for cell in chunk]
    refusals = 0
    while True:
        try:
            return await openmeteo.request_forecasts(outbound, points)
        except ProviderRateLimited as refused:
            refusals += 1
            wait = _wait_for(refused.retry_after_s, deadline, runtime)
            if wait is None or refusals > MAX_REFUSALS_PER_CHUNK:
                raise
            logger.info("weather: refused, waiting %.0f s", wait)
            await runtime.sleep(wait)


def _wait_for(delay_s: float | None, deadline: float, runtime: Runtime) -> float | None:
    """Seconds to wait before retrying a refusal, or None when it must be raised instead."""
    if delay_s is None or delay_s > MAX_RETRY_DELAY_S:
        return None
    wait = delay_s + RETRY_PAD_S
    return wait if runtime.time() + wait < deadline else None


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
        hourly = conditions_by_hour(series_by_cell[grid_cell.forecast], hour, GRID_HOURS)
        codes = [None if (risk := classify(c)) is None else risk.level.score for c in hourly]
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
    ranking = rank_routes(candidates, spacing_miles)
    return {
        "recommended_id": ranking.recommended_id,
        "decided_by": ranking.decided_by,
        "routes": ranking.routes,
    }
