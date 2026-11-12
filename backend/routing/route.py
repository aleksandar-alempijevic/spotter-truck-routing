"""A route as the rest of the app sees it, independent of the provider that computed it."""

import bisect
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

from .geo import METERS_PER_MILE, Point, haversine_m

type RouteSource = Literal["provider", "via_city"]

KNOT_TIME_TOLERANCE_S = 1.0
"""How far the last knot's time may differ from the travel time before the route is rejected."""


class RouteContractError(ValueError):
    """A route's data breaks the rules the checkpoint and summary code rely on."""


def _locate(xs: Sequence[float], x: float) -> tuple[int, float]:
    """The segment of the ascending `xs` that holds x, and how far along it x lies (0 to 1).

    x must lie within xs, and xs must have at least two entries.
    """
    j = min(bisect.bisect_right(xs, x) - 1, len(xs) - 2)
    span = xs[j + 1] - xs[j]
    return j, (x - xs[j]) / span if span > 0 else 0.0


@dataclass(frozen=True, slots=True)
class Via:
    """A city a route was forced through."""

    name: str
    lat: float
    lon: float


@dataclass(frozen=True, slots=True)
class Route:
    """One route: its geometry, its length and travel time, and how time builds up along it.

    `length_m` is the one distance scale: polyline distances are stretched or shrunk to it, so
    the polyline and the time knots agree. A knot is (metres from the start, seconds from
    departure); the knots must not go backwards and the last one's time must equal
    `travel_time_s`. A route that breaks this is rejected, never repaired.
    """

    points: tuple[Point, ...]
    length_m: float
    travel_time_s: float
    knots: tuple[tuple[float, float], ...]
    via: Via | None = None
    _cumulative_m: tuple[float, ...] = field(init=False, repr=False, compare=False)
    _knot_meters: tuple[float, ...] = field(init=False, repr=False, compare=False)
    _knot_seconds: tuple[float, ...] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if len(self.points) < 2:
            raise RouteContractError("a route needs at least two points")
        if not all(
            math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180
            for lat, lon in self.points
        ):
            raise RouteContractError("every point must be a finite latitude and longitude")
        if not (math.isfinite(self.length_m) and self.length_m > 0):
            raise RouteContractError("a route's length must be a finite number above 0")
        if not (math.isfinite(self.travel_time_s) and self.travel_time_s >= 0):
            raise RouteContractError("a route's travel time must be a finite number of at least 0")
        if not self.knots:
            raise RouteContractError("a route needs time knots")
        for (x0, t0), (x1, t1) in zip(self.knots, self.knots[1:], strict=False):
            if x1 < x0 or t1 < t0:
                raise RouteContractError("time knots must not go backwards")
        if self.knots[0][0] < 0 or any(not math.isfinite(x + t) for x, t in self.knots):
            raise RouteContractError("time knots must be finite and start at or after the start")
        if abs(self.knots[-1][1] - self.travel_time_s) > KNOT_TIME_TOLERANCE_S:
            raise RouteContractError("the last time knot must equal the route's travel time")

        cumulative = [0.0]
        for previous, current in zip(self.points, self.points[1:], strict=False):
            cumulative.append(cumulative[-1] + haversine_m(previous, current))
        if cumulative[-1] <= 0:
            raise RouteContractError("a route's points must not all coincide")
        scale = self.length_m / cumulative[-1]
        object.__setattr__(self, "_cumulative_m", tuple(d * scale for d in cumulative))
        # Time runs in from 0 at the start, so a first knot after the start gets one there.
        start = [] if self.knots[0][0] == 0 else [(0.0, 0.0)]
        meters, seconds = zip(*[*start, *self.knots], strict=True)
        object.__setattr__(self, "_knot_meters", meters)
        object.__setattr__(self, "_knot_seconds", seconds)

    @property
    def total_miles(self) -> float:
        return self.length_m / METERS_PER_MILE

    @property
    def source(self) -> RouteSource:
        return "via_city" if self.via else "provider"

    def seconds_at(self, meters: float) -> float:
        """Seconds from departure at a distance along the route, interpolated between knots.

        At the start the time is 0, and past the last knot it stays at the travel time.
        """
        if meters >= self._knot_meters[-1]:
            return self.travel_time_s
        if meters <= 0:
            return 0.0
        j, fraction = _locate(self._knot_meters, meters)
        t0, t1 = self._knot_seconds[j], self._knot_seconds[j + 1]
        return t0 + (t1 - t0) * fraction

    def position_at(self, meters: float) -> Point:
        """The point on the polyline at a distance along the route, interpolated between points."""
        if meters <= 0:
            return self.points[0]
        if meters >= self._cumulative_m[-1]:
            return self.points[-1]
        j, fraction = _locate(self._cumulative_m, meters)
        (lat0, lon0), (lat1, lon1) = self.points[j], self.points[j + 1]
        return (lat0 + (lat1 - lat0) * fraction, lon0 + (lon1 - lon0) * fraction)
