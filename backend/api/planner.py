"""The route-planning use case: base call, via-city fill, checkpoints and the shortfall reason.

Decisions live in `routing`; this module only sequences the awaits.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

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
    measure_overlap,
    near_cells,
    order_routes,
    simplify_line,
    via_candidates,
)
from routing.overlap import Cells, Overlap

logger = logging.getLogger(__name__)

WANTED_ROUTES = 3
PLANNING_BUDGET_S = 120.0
"""One deadline for the whole request. When it passes during the fill, the routes in hand are
returned; when it passes during the base call, the request times out."""

ShortfallReason = Literal["no_distinct_alternative", "fill_incomplete"]
NO_DISTINCT_ALTERNATIVE: ShortfallReason = "no_distinct_alternative"
FILL_INCOMPLETE: ShortfallReason = "fill_incomplete"


@dataclass(frozen=True, slots=True)
class Shortfall:
    reason: ShortfallReason
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
    deadline = asyncio.get_running_loop().time() + PLANNING_BUDGET_S

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
            async with asyncio.timeout_at(deadline):
                routes = await route_call(None, WANTED_ROUTES - 1)
        except TimeoutError:
            raise ProviderTimeout from None

        shortfall = None
        if len(routes) < WANTED_ROUTES:
            routes, shortfall = await _fill(routes, route_call, origin, destination, deadline)

    planned = await asyncio.to_thread(_finish, routes, spacing_miles, departure)
    return Plan(planned, shortfall)


async def _fill(
    routes: list[Route],
    route_call: Callable[[Via | None, int], Awaitable[list[Route]]],
    origin: Point,
    destination: Point,
    deadline: float,
) -> tuple[list[Route], Shortfall | None]:
    """Try via-cities until the gap is filled or the deadline passes.

    Candidates are chosen against every route in hand, both sides of the trip. Every call starts
    at once and the shared outbound cap lets four run at a time. As each answer arrives it is
    judged against the routes kept so far, and once three are kept the calls still pending are
    cancelled, so a gap that fills early costs few calls. When the deadline passes the routes in
    hand are returned.
    """
    vias = via_candidates(origin, destination, [r.points for r in routes])
    kept = list(routes)
    kept_cells = await asyncio.to_thread(lambda: [near_cells(r.points) for r in kept])
    pending = {asyncio.ensure_future(route_call(via, 0)): via for via in vias}
    tried: list[str] = []
    incomplete = False
    try:
        async with asyncio.timeout_at(deadline):
            while pending and len(kept) < WANTED_ROUTES:
                done, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    via = pending.pop(task)
                    if len(kept) >= WANTED_ROUTES:
                        _consume(task)
                        continue
                    if await _judge(task, via, kept, kept_cells):
                        tried.append(via.name)
                    else:
                        incomplete = True
    except TimeoutError:
        incomplete = True
    finally:
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    if len(kept) >= WANTED_ROUTES:
        return kept, None
    return kept, _shortfall(len(kept), incomplete, tried)


def _consume(task: asyncio.Future[list[Route]]) -> None:
    """Mark a finished call's outcome as seen, so a skipped failure is not reported at exit."""
    if not task.cancelled():
        task.exception()


async def _judge(
    task: asyncio.Future[list[Route]], via: Via, kept: list[Route], kept_cells: list[Cells]
) -> bool:
    """Keep the via route if it is distinct enough from the routes kept so far.

    True when the candidate was judged (kept or rejected, or no road goes through the city);
    False when the call failed. The overlap work runs in a thread, and `kept` and `kept_cells`
    change only after it returns.
    """
    if task.cancelled():
        return False
    error = task.exception()
    if isinstance(error, NoRouteFound):
        return True
    if error is not None:
        if not isinstance(error, ProviderError):
            raise error
        logger.warning("via-city route failed: %s", type(error).__name__)
        return False
    candidate = min(task.result(), key=lambda r: (r.travel_time_s, r.length_m))
    overlap, cells = await asyncio.to_thread(_measure, candidate, kept_cells)
    logger.info("via-city %s: overlap %.2f with the routes in hand", via.name, overlap.share)
    if overlap.distinct:
        kept.append(candidate)
        kept_cells.append(cells)
    return True


def _measure(candidate: Route, kept_cells: list[Cells]) -> tuple[Overlap, Cells]:
    return measure_overlap(candidate.points, kept_cells), near_cells(candidate.points)


def _shortfall(count: int, incomplete: bool, tried: list[str]) -> Shortfall:
    found = f"Only {count} route{'s' if count != 1 else ''}"
    where = f" (routes through {', '.join(tried)} were tried)" if tried else ""
    if incomplete:
        return Shortfall(
            FILL_INCOMPLETE,
            f"{found} could be found{where}: the search for another route did not finish. "
            "Try again to look for a third route.",
        )
    if not tried:
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
