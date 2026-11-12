"""A route as the rest of the app sees it, independent of the provider that computed it."""

import bisect
import math
from dataclasses import dataclass, field

from .geo import METERS_PER_MILE, Point, haversine_m

KNOT_TIME_TOLERANCE_S = 1.0
"""How far the last knot's time may differ from the travel time before the route is rejected."""


class RouteContractError(ValueError):
    """A route's data breaks the rules the checkpoint and summary code rely on."""


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

    def __post_init__(self) -> None:
        if len(self.points) < 2:
            raise RouteContractError("a route needs at least two points")
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

    @property
    def total_miles(self) -> float:
        return self.length_m / METERS_PER_MILE

    @property
    def source(self) -> str:
        return "via_city" if self.via else "provider"

    def seconds_at(self, meters: float) -> float:
        """Seconds from departure at a distance along the route, interpolated between knots.

        Before the first knot the time runs in from 0, and past the last it stays at the last.
        """
        knots = self.knots
        if meters >= knots[-1][0]:
            return self.travel_time_s
        if meters <= 0:
            return 0.0
        xs = [x for x, _ in knots]
        j = bisect.bisect_right(xs, meters)
        x0, t0 = knots[j - 1] if j > 0 else (0.0, 0.0)
        x1, t1 = knots[j]
        return t0 + (t1 - t0) * ((meters - x0) / (x1 - x0)) if x1 > x0 else t1

    def position_at(self, meters: float) -> Point:
        """The point on the polyline at a distance along the route, interpolated between points."""
        cumulative = self._cumulative_m
        if meters <= 0:
            return self.points[0]
        if meters >= cumulative[-1]:
            return self.points[-1]
        j = bisect.bisect_right(cumulative, meters)
        d0, d1 = cumulative[j - 1], cumulative[j]
        fraction = (meters - d0) / (d1 - d0) if d1 > d0 else 0.0
        (lat0, lon0), (lat1, lon1) = self.points[j - 1], self.points[j]
        return (lat0 + (lat1 - lat0) * fraction, lon0 + (lon1 - lon0) * fraction)
