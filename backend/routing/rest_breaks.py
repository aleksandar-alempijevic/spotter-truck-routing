"""The federal rest-break rule for one driver, as a schedule of stops along a route's driving time.

`plan_stops` is the only place that decides a stop. Everything else here derives from its result:
the time elapsed at a point of the drive, and where and when each stop falls on a route.

The rule is 49 CFR 395.3 for one property-carrying driver (checked in the project's hours-of-
service report): a 30-minute break once 8 hours have been driven without one, 10 hours off once
11 hours have been driven since the last rest, and 34 hours off once 60 hours have been driven in
a cycle (the stricter of the 60-hour and 70-hour limits, as the carrier's schedule is unknown). The
model assumes a rested start, a driver who does nothing but drive, and no exception: no sleeper-
berth split, no adverse-driving-conditions extension, no short-haul exemption. Under those
assumptions the 14-hour window cannot bind, so it has no counter.
"""

from bisect import bisect_left
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import accumulate
from typing import Literal

from .geo import METERS_PER_MILE
from .route import Route

StopKind = Literal["break", "rest", "restart"]

BREAK_AFTER_DRIVING_S = 8 * 3600
"""§395.3(a)(3)(ii): no driving once more than 8 hours have passed without a 30-minute break."""
BREAK_S = 30 * 60
SHIFT_DRIVING_S = 11 * 3600
"""§395.3(a)(3)(i): at most 11 hours of driving after 10 consecutive hours off."""
REST_S = 10 * 3600
CYCLE_DRIVING_S = 60 * 3600
"""§395.3(b): 60 hours in 7 days, the stricter limit. Under the model every hour on duty is an
hour driven, and a trip starts with none used."""
RESTART_S = 34 * 3600
"""§395.3(c): 34 consecutive hours off duty end the cycle."""


@dataclass(frozen=True, slots=True)
class RestStop:
    """A stop the rule requires: it begins after `driving_s` seconds of driving."""

    kind: StopKind
    driving_s: float
    duration_seconds: int


def plan_stops(driving_s: float) -> tuple[RestStop, ...]:
    """The stops a trip of `driving_s` seconds at the wheel needs, in order.

    A stop that would begin at or after the end of the trip is not needed, so a trip that ends
    exactly at a limit has no stop for it. When limits are reached together the longest stop wins
    and ends the periods the shorter one would have.
    """
    stops: list[RestStop] = []
    # Driving seconds; the limits are whole seconds, so these stay exact.
    since_break = shift = cycle = 0
    position = 0.0
    while True:
        to_cycle = CYCLE_DRIVING_S - cycle
        to_shift = SHIFT_DRIVING_S - shift
        to_break = BREAK_AFTER_DRIVING_S - since_break
        step = min(to_cycle, to_shift, to_break)
        if position + step >= driving_s:
            return tuple(stops)
        position += step
        if step == to_cycle:
            stops.append(RestStop("restart", position, RESTART_S))
            since_break = shift = cycle = 0
        elif step == to_shift:
            stops.append(RestStop("rest", position, REST_S))
            since_break = shift = 0
            cycle += step
        else:
            stops.append(RestStop("break", position, BREAK_S))
            since_break = 0
            shift += step
            cycle += step


class StopClock:
    """The time elapsed at a point of the drive, given a schedule of stops.

    The offsets are summed once here, so each lookup is one bisect.
    """

    def __init__(self, stops: Sequence[RestStop]):
        self._starts = [stop.driving_s for stop in stops]
        self._stopped_before = list(
            accumulate((stop.duration_seconds for stop in stops), initial=0)
        )

    def elapsed_at(self, driving_s: float) -> float:
        """Seconds from departure at a point of the drive, counting the stops taken before it.

        A point reached exactly where a stop begins is reached before the stop, so it gets the
        arrival time. Strictly increasing in `driving_s`.
        """
        return driving_s + self._stopped_before[bisect_left(self._starts, driving_s)]


@dataclass(frozen=True, slots=True)
class RouteStop:
    """A stop placed on a route: where the truck stands and when the stop begins."""

    kind: StopKind
    mile: float
    lat: float
    lon: float
    starts_at: datetime
    duration_seconds: int


def locate_stops(route: Route, stops: Sequence[RestStop], departure: datetime) -> list[RouteStop]:
    """Each stop's position on the route, through `Route.meters_at`, and its start instant."""
    start = departure.astimezone(UTC)
    clock = StopClock(stops)
    located = []
    for stop in stops:
        meters = route.meters_at(stop.driving_s)
        lat, lon = route.position_at(meters)
        located.append(
            RouteStop(
                stop.kind,
                meters / METERS_PER_MILE,
                lat,
                lon,
                start + timedelta(seconds=clock.elapsed_at(stop.driving_s)),
                stop.duration_seconds,
            )
        )
    return located
