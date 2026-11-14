"""Checkpoints along a route, with positions and ETAs.

The marks follow what `risk_rules.summarize_route` requires, so its output is accepted as is: the
first mark is at mile 0, marks strictly ascend, and the last mark is the route's total miles (the
destination). This package and `risk_rules` never import each other.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .geo import METERS_PER_MILE
from .rest_breaks import RestStop, StopClock
from .route import Route

MARK_EPSILON_MILES = 1e-6


@dataclass(frozen=True, slots=True)
class RouteCheckpoint:
    mile: float
    lat: float
    lon: float
    eta: datetime
    """UTC instant of arrival at this mark, including the stops before it."""


def checkpoint_marks(total_miles: float, spacing_miles: float) -> list[float]:
    """Mile marks every `spacing_miles` from 0, then the end of the route.

    A mark that would coincide with the end is not emitted twice.
    """
    if spacing_miles <= 0:
        raise ValueError("the checkpoint spacing must be above 0")
    marks = [0.0]
    step = 1
    while step * spacing_miles < total_miles - MARK_EPSILON_MILES:
        marks.append(step * spacing_miles)
        step += 1
    if total_miles > MARK_EPSILON_MILES:
        marks.append(total_miles)
    return marks


def build_checkpoints(
    route: Route, spacing_miles: float, departure: datetime, stops: Sequence[RestStop] = ()
) -> list[RouteCheckpoint]:
    """Checkpoints at the spacing, from the full-resolution geometry and the time knots.

    The route's knots give driving time; `stops` (none by default, so ETAs are driving time only)
    add the time spent stopped before each mark.
    """
    start = departure.astimezone(UTC)
    clock = StopClock(stops)
    result = []
    for mile in checkpoint_marks(route.total_miles, spacing_miles):
        meters = min(mile * METERS_PER_MILE, route.length_m)
        lat, lon = route.position_at(meters)
        seconds = route.travel_time_s if mile >= route.total_miles else route.seconds_at(meters)
        eta = start + timedelta(seconds=clock.elapsed_at(seconds))
        result.append(RouteCheckpoint(mile, lat, lon, eta))
    return result
