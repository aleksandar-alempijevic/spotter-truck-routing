"""The route-planning use case: base call, via-city fill, checkpoints and the shortfall reason.

Decisions live in `routing`; this module only sequences the awaits.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime

from providers import (
    MAX_CONCURRENT_CALLS,
    NoRouteFound,
    Outbound,
    ProviderError,
    ProviderTimeout,
    calculate_routes,
)
from routing import (
    MAX_OVERLAP,
    Point,
    Route,
    RouteCheckpoint,
    Via,
    build_checkpoints,
    order_routes,
    simplify_line,
    via_candidates,
    worst_overlap,
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
    """Try via-cities until the gap is filled, a few at a time within the outbound cap.

    Candidates are chosen against every route in hand and come both sides of the trip at once.
    As each answer arrives it is judged against the routes kept so far, and the next candidate
    starts in its place; once three routes are kept the calls still pending are cancelled, so a
    gap that is filled early costs few calls.
    """
    vias = via_candidates(origin, destination, [r.points for r in routes])
    queue = list(vias)
    pending: dict[asyncio.Future[list[Route]], Via] = {}
    kept = list(routes)
    judged: list[str] = []
    incomplete = False
    try:
        while len(kept) < WANTED_ROUTES and (queue or pending):
            while queue and len(pending) < MAX_CONCURRENT_CALLS:
                via = queue.pop(0)
                pending[asyncio.ensure_future(route_call(via, 0))] = via
            done, _ = await asyncio.wait(
                pending, timeout=max(remaining(), 0.0), return_when=asyncio.FIRST_COMPLETED
            )
            if not done:
                incomplete = True
                break
            for task in done:
                via = pending.pop(task)
                if len(kept) >= WANTED_ROUTES:
                    continue
                outcome = _judge(task, via, kept)
                if outcome is None:
                    incomplete = True
                else:
                    judged.append(via.name)
    finally:
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    if len(kept) >= WANTED_ROUTES:
        return kept, None
    return kept, _shortfall(len(kept), incomplete, bool(vias), judged)


def _judge(task: asyncio.Future[list[Route]], via: Via, kept: list[Route]) -> bool | None:
    """Add the via route to `kept` if it is distinct enough. None when the call failed.

    True when the candidate was judged (kept or rejected, or no road goes through the city).
    """
    if task.cancelled():
        return None
    error = task.exception()
    if isinstance(error, NoRouteFound):
        return True
    if error is not None:
        if not isinstance(error, ProviderError):
            raise error
        logger.warning("via-city route failed: %s", type(error).__name__)
        return None
    for candidate in sorted(task.result(), key=lambda r: (r.travel_time_s, r.length_m)):
        overlap = worst_overlap(candidate.points, [r.points for r in kept])
        logger.info("via-city %s: overlap %.2f with the routes in hand", via.name, overlap)
        if overlap < MAX_OVERLAP and len(kept) < WANTED_ROUTES:
            kept.append(candidate)
    return True


def _shortfall(count: int, incomplete: bool, had_candidates: bool, tried: list[str]) -> Shortfall:
    found = f"Only {count} route{'s' if count != 1 else ''}"
    where = f" (routes through {', '.join(tried)} were tried)" if tried else ""
    if incomplete:
        return Shortfall(
            FILL_INCOMPLETE,
            f"{found} could be found{where}: the search for another route did not finish. "
            "Try again to look for a third route.",
        )
    if not had_candidates:
        return Shortfall(
            NO_DISTINCT_ALTERNATIVE,
            f"{found} found, and no large city lies far enough from them to route through.",
        )
    return Shortfall(
        NO_DISTINCT_ALTERNATIVE,
        f"{found} found. Routes through {', '.join(tried)} were tried and none differs enough "
        "from the routes shown.",
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
