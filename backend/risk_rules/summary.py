"""From a route's checkpoints to the route summary the ranking compares."""

import math
from collections.abc import Sequence
from dataclasses import dataclass

from .levels import Level


@dataclass(frozen=True, slots=True)
class Checkpoint:
    """A checkpoint: miles from the route's start, and its level (None without a forecast)."""

    mile: float
    level: Level | None


@dataclass(frozen=True, slots=True)
class RouteSummary:
    """Miles at each level, the miles with no forecast, and the mile-weighted average risk."""

    miles_by_level: dict[Level, float]
    no_forecast_miles: float
    average_risk: float | None
    """Mile-weighted average of the level scores over forecasted miles; None if there are none."""
    forecast_checkpoints: int
    """Checkpoints that have a forecast and stand for more than zero miles."""

    @property
    def no_travel_miles(self) -> float:
        return self.miles_by_level[Level.NO_TRAVEL]

    @property
    def severe_miles(self) -> float:
        return self.miles_by_level[Level.SEVERE]

    @property
    def high_miles(self) -> float:
        return self.miles_by_level[Level.HIGH]


def summarize_route(total_miles: float, checkpoints: Sequence[Checkpoint]) -> RouteSummary:
    """Attribute the route's miles to its checkpoints and total them by level.

    Each checkpoint stands for the road from its mile mark up to the next mark, and the last one
    up to the end of the route. Marks must start at mile 0, strictly ascend and not pass
    `total_miles`; a final checkpoint at the destination stands for no miles. Miles of a
    checkpoint without a forecast are counted apart and never as Low.
    """
    if not math.isfinite(total_miles) or total_miles < 0:
        raise ValueError(f"total_miles must be a finite number of at least 0, got {total_miles!r}")
    if not checkpoints:
        raise ValueError("a route needs at least one checkpoint")
    if checkpoints[0].mile != 0:
        raise ValueError("the first checkpoint must be at mile 0, so no road precedes it")
    marks = [checkpoint.mile for checkpoint in checkpoints]
    if not all(math.isfinite(mark) for mark in marks):
        raise ValueError("checkpoint miles must be finite numbers")
    if any(later <= earlier for earlier, later in zip(marks, marks[1:], strict=False)):
        raise ValueError("checkpoint miles must be strictly ascending")
    if marks[-1] > total_miles:
        raise ValueError("a checkpoint lies beyond the end of the route")

    miles_by_level = dict.fromkeys(Level, 0.0)
    no_forecast_miles = 0.0
    forecast_checkpoints = 0
    ends = [*marks[1:], total_miles]
    for checkpoint, end in zip(checkpoints, ends, strict=True):
        miles = end - checkpoint.mile
        if checkpoint.level is None:
            no_forecast_miles += miles
            continue
        miles_by_level[checkpoint.level] += miles
        if miles > 0:
            forecast_checkpoints += 1

    forecast_miles = sum(miles_by_level.values())
    average_risk = (
        sum(level.score * miles for level, miles in miles_by_level.items()) / forecast_miles
        if forecast_miles > 0
        else None
    )
    return RouteSummary(
        miles_by_level=miles_by_level,
        no_forecast_miles=no_forecast_miles,
        average_risk=average_risk,
        forecast_checkpoints=forecast_checkpoints,
    )
