"""The route-planning use case: base call, via-city fill, checkpoints and the shortfall reason.

Decisions live in `routing`; this module only sequences the awaits.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime

from providers import (
    NoRouteFound,
    Outbound,
    ProviderError,
    ProviderTimeout,
    calculate_routes,
)
from routing import (
    Point,
    Route,
    RouteCheckpoint,
    Via,
    build_checkpoints,
    is_distinct,
    order_routes,
    simplify_line,
    via_candidates,
)

logger = logging.getLogger(__name__)

WANTED_ROUTES = 3
PLANNING_BUDGET_S = 120.0
"""One budget for the whole request. When it runs out during the fill, the routes in hand are
returned; when it runs out during the base call, the request times out."""

NO_DISTINCT_ALTERNATIVE = "no_distinct_alternative"
FILL_INCOMPLETE = "fill_incomplete"


@dataclass(frozen=True, slots=True)
class Shortfall:
    reason: str
    message: str


@dataclass(frozen=True, slots=True)
class PlannedRoute:
    id: str
    route: Route
    checkpoints: list[RouteCheckpoint]
    line: list[Point]
    """Reduced geometry in (lat, lon) order."""


@dataclass(frozen=True, slots=True)
class Plan:
    routes: list[PlannedRoute]
    shortfall: Shortfall | None


async def plan_routes(
    api_key: str,
    *,
    origin: Point,
    destination: Point,
    departure: datetime,
    load_lb: float,
    spacing_miles: float,
) -> Plan:
    """Up to three distinct truck routes with checkpoints; fewer, with the reason, when none more
    can be built. Raises a `ProviderError` when no route could be found at all."""
    started = asyncio.get_running_loop().time()

    def remaining() -> float:
        return PLANNING_BUDGET_S - (asyncio.get_running_loop().time() - started)

    async with Outbound() as outbound:

        async def route_call(via: Via | None, alternatives: int) -> list[Route]:
            return await calculate_routes(
                outbound,
                api_key,
                origin=origin,
                destination=destination,
                departure=departure,
                load_lb=load_lb,
                alternatives=alternatives,
                via=via,
            )

        try:
            async with asyncio.timeout(PLANNING_BUDGET_S):
                routes = await route_call(None, WANTED_ROUTES - 1)
        except TimeoutError:
            raise ProviderTimeout from None

        shortfall = None
        if len(routes) < WANTED_ROUTES:
            routes, shortfall = await _fill(routes, route_call, origin, destination, remaining)

    planned = await asyncio.to_thread(_finish, routes, spacing_miles, departure)
    return Plan(planned, shortfall)


async def _fill(
    routes: list[Route],
    route_call: Callable[[Via | None, int], Awaitable[list[Route]]],
    origin: Point,
    destination: Point,
    remaining: Callable[[], float],
) -> tuple[list[Route], Shortfall | None]:
    """Try a via-city on each side of the main route at once; keep what is distinct enough."""
    main = min(routes, key=lambda r: (r.travel_time_s, r.length_m))
    vias = via_candidates(origin, destination, main.points)
    tasks = [asyncio.ensure_future(route_call(via, 0)) for via in vias]
    try:
        if tasks:
            await asyncio.wait(tasks, timeout=max(remaining(), 0.0))
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    incomplete = False
    candidates: list[Route] = []
    for task in tasks:
        if task.cancelled() or not task.done():
            incomplete = True
        elif isinstance(task.exception(), NoRouteFound):
            continue
        elif task.exception() is not None:
            if not isinstance(task.exception(), ProviderError):
                raise task.exception()
            logger.warning("via-city route failed: %s", type(task.exception()).__name__)
            incomplete = True
        else:
            candidates.extend(task.result())

    kept = list(routes)
    for candidate in sorted(candidates, key=lambda r: (r.travel_time_s, r.length_m)):
        if len(kept) >= WANTED_ROUTES:
            break
        if is_distinct(candidate.points, [r.points for r in kept]):
            kept.append(candidate)
    if len(kept) >= WANTED_ROUTES:
        return kept, None
    return kept, _shortfall(len(kept), incomplete)


def _shortfall(count: int, incomplete: bool) -> Shortfall:
    found = f"Only {count} route{'s' if count != 1 else ''}"
    if incomplete:
        return Shortfall(
            FILL_INCOMPLETE,
            f"{found} could be found: the search for another route did not finish. "
            "Try again to look for a third route.",
        )
    return Shortfall(
        NO_DISTINCT_ALTERNATIVE,
        f"{found} exist{'s' if count == 1 else ''} between these points: no other route differs "
        "enough from the ones shown.",
    )


def _finish(routes: list[Route], spacing_miles: float, departure: datetime) -> list[PlannedRoute]:
    return [
        PlannedRoute(
            route_id,
            route,
            build_checkpoints(route, spacing_miles, departure),
            simplify_line(route.points),
        )
        for route_id, route in order_routes(routes)
    ]
