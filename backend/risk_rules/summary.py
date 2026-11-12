"""From a route's checkpoints to the route summary the ranking compares."""

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType

from .levels import Level


@dataclass(frozen=True, slots=True)
class Checkpoint:
    """A checkpoint: miles from the route's start, and its level (None without a forecast)."""

    mile: float
    level: Level | None


@dataclass(frozen=True, slots=True)
class RouteSummary:
    """Miles at each level, the miles with no forecast, and the mile-weighted average risk.

    Construction checks the summary's own invariants: every mileage is finite and at least 0, and
    the average risk is present exactly when some miles have a forecast, and equals the
    mile-weighted average of the level scores.
    """

    low_miles: float
    moderate_miles: float
    high_miles: float
    severe_miles: float
    no_travel_miles: float
    no_forecast_miles: float
    average_risk: float | None
    """Mile-weighted average of the level scores over forecasted miles; None if there are none."""

    def __post_init__(self) -> None:
        miles = (*self._level_miles(), self.no_forecast_miles)
        if not all(math.isfinite(m) and m >= 0 for m in miles):
            raise ValueError("summary miles must be finite numbers of at least 0")
        forecast_miles = self.forecast_miles
        if forecast_miles <= 0:
            if self.average_risk is not None:
                raise ValueError("a summary without forecasted miles has no average risk")
            return
        if self.average_risk is None:
            raise ValueError("a summary with forecasted miles needs an average risk")
        expected = (
            sum(level.score * m for level, m in zip(Level, self._level_miles(), strict=True))
            / forecast_miles
        )
        if not math.isclose(self.average_risk, expected, rel_tol=1e-9, abs_tol=1e-9):
            raise ValueError("average risk does not match the miles at each level")

    def _level_miles(self) -> tuple[float, ...]:
        return (
            self.low_miles,
            self.moderate_miles,
            self.high_miles,
            self.severe_miles,
            self.no_travel_miles,
        )

    @property
    def miles_by_level(self) -> Mapping[Level, float]:
        """Read-only miles at each of the five levels."""
        return MappingProxyType(dict(zip(Level, self._level_miles(), strict=True)))

    @property
    def forecast_miles(self) -> float:
        """Miles whose checkpoint has a forecast."""
        return sum(self._level_miles())


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
    ends = [*marks[1:], total_miles]
    for checkpoint, end in zip(checkpoints, ends, strict=True):
        miles = end - checkpoint.mile
        if checkpoint.level is None:
            no_forecast_miles += miles
        else:
            miles_by_level[checkpoint.level] += miles

    forecast_miles = sum(miles_by_level.values())
    average_risk = (
        sum(level.score * miles for level, miles in miles_by_level.items()) / forecast_miles
        if forecast_miles > 0
        else None
    )
    return RouteSummary(
        low_miles=miles_by_level[Level.LOW],
        moderate_miles=miles_by_level[Level.MODERATE],
        high_miles=miles_by_level[Level.HIGH],
        severe_miles=miles_by_level[Level.SEVERE],
        no_travel_miles=miles_by_level[Level.NO_TRAVEL],
        no_forecast_miles=no_forecast_miles,
        average_risk=average_risk,
    )
