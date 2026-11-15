"""Ranking one to three routes: safety first, with travel time deciding within forecast noise."""

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum

from .summary import RouteSummary

# Segment miles are differences of float marks, so two quantities that are equal on paper can
# differ by a rounding error. Values within this margin count as equal when routes are compared.
FLOAT_MARGIN = 1e-6


class RankingStep(StrEnum):
    """The steps a ranking applies, in order; the values are the wire names."""

    NO_TRAVEL = "no_travel"
    SEVERE = "severe"
    HIGH = "high"
    AVERAGE_RISK = "average_risk"
    TRAVEL_TIME = "travel_time"
    MILES = "miles"
    ROUTE_ID = "route_id"


@dataclass(frozen=True, slots=True)
class RouteCandidate:
    route_id: str
    travel_time_seconds: float
    summary: RouteSummary

    @property
    def total_miles(self) -> float:
        """The route's length, derived from its summary so the two cannot disagree."""
        return self.summary.forecast_miles + self.summary.no_forecast_miles


@dataclass(frozen=True, slots=True)
class StepMeasure:
    """What a route was measured against at the step where it dropped out."""

    best_route_id: str
    """The best route among those still in the contest at that step."""
    route_value: float | None
    """The dropped route's value at the step. None in two cases: it had no value (no average
    risk), or the step is the route-id step, which compares no values (best_value is None too)."""
    best_value: float | None
    """The best route's value at the step; None at the route-id step, which compares no value."""
    tolerance: float
    """How far above the best the dropped route could be and still stay in."""


@dataclass(frozen=True, slots=True)
class RouteComparison:
    """How a route differs from the recommended-order winner: its value minus the winner's."""

    dropped_at: RankingStep
    """The step at which the route left the contest for first place."""
    dropped_against: StepMeasure
    """What the route lost to at that step. That route is the step's best, not always the winner."""
    travel_time_seconds: float
    no_travel_miles: float
    severe_miles: float
    high_miles: float
    average_risk: float | None
    """None when either route has no average risk."""


@dataclass(frozen=True, slots=True)
class RankedRoute:
    route_id: str
    rank: int
    no_forecast_miles: float
    average_risk_tolerance: float | None
    """The route's own tolerance at the average-risk step, whether or not it dropped there;
    None if the route has no average risk."""
    vs_first: RouteComparison | None
    """None for the first-ranked route."""


@dataclass(frozen=True, slots=True)
class Ranking:
    routes: tuple[RankedRoute, ...]
    """All routes, best first."""
    recommended_id: str | None
    """The first-ranked route, or None when it has No Travel miles."""
    decided_by: RankingStep | None
    """The step after which only the first-ranked route remained; None for a single route, which
    no step had to decide."""


@dataclass(frozen=True, slots=True)
class _Step:
    step: RankingStep
    value: Callable[[RouteCandidate], float | None]
    """The quantity compared; None means the route has no value and compares worse than any."""
    tolerance: Callable[[RouteCandidate], float]
    """How far above the best a route's value may be and still stay in the contest."""


def _average_risk_tolerance(summary: RouteSummary, interval_miles: float) -> float:
    """One full-interval checkpoint moving one level shifts a route's average by
    interval / its forecast miles, capped at one level for routes forecast for less than an
    interval."""
    return min(1.0, interval_miles / summary.forecast_miles)


def _steps(interval_miles: float) -> list[_Step]:
    def zero(_: RouteCandidate) -> float:
        return 0.0

    def one_interval(_: RouteCandidate) -> float:
        # High tolerates one interval of road, as the average-risk tolerance does for one
        # checkpoint's level; Severe tolerates none.
        return interval_miles

    def average_risk_tolerance(c: RouteCandidate) -> float:
        # Only called for routes that have an average, so forecast miles are > 0.
        return _average_risk_tolerance(c.summary, interval_miles)

    return [
        _Step(RankingStep.NO_TRAVEL, lambda c: c.summary.no_travel_miles, zero),
        _Step(RankingStep.SEVERE, lambda c: c.summary.severe_miles, zero),
        _Step(RankingStep.HIGH, lambda c: c.summary.high_miles, one_interval),
        _Step(RankingStep.AVERAGE_RISK, lambda c: c.summary.average_risk, average_risk_tolerance),
        _Step(RankingStep.TRAVEL_TIME, lambda c: c.travel_time_seconds, zero),
        _Step(RankingStep.MILES, lambda c: c.total_miles, zero),
    ]


def _apply_step(
    step: _Step, survivors: list[RouteCandidate]
) -> tuple[list[RouteCandidate], dict[str, StepMeasure]]:
    """Keep the survivors within their tolerance of the best; say what each dropped one lost to.

    The best is the lowest value among the survivors, so a route is compared with the best route
    still in the contest, not with the route that eventually wins. A step where no survivor has a
    value keeps everyone.
    """
    valued = [c for c in survivors if step.value(c) is not None]
    if not valued:
        return survivors, {}
    best_route = min(valued, key=lambda c: (step.value(c), c.route_id))
    best = step.value(best_route)
    kept, dropped = [], {}
    for c in survivors:
        value = step.value(c)
        if value is not None and value - step.tolerance(c) <= best + FLOAT_MARGIN:
            kept.append(c)
        else:
            tolerance = step.tolerance(c) if value is not None else 0.0
            dropped[c.route_id] = StepMeasure(best_route.route_id, value, best, tolerance)
    return kept, dropped


def _first_place(
    candidates: list[RouteCandidate], interval_miles: float
) -> tuple[RouteCandidate, RankingStep, dict[str, tuple[RankingStep, StepMeasure]]]:
    """Filter step by step; return the winner, the deciding step and where each loser dropped."""
    survivors = candidates
    drops: dict[str, tuple[RankingStep, StepMeasure]] = {}
    for step in _steps(interval_miles):
        survivors, dropped = _apply_step(step, survivors)
        drops.update({route_id: (step.step, measure) for route_id, measure in dropped.items()})
        if len(survivors) == 1:
            return survivors[0], step.step, drops
    winner = min(survivors, key=lambda c: c.route_id)
    for c in survivors:
        if c is not winner:
            drops[c.route_id] = (
                RankingStep.ROUTE_ID,
                StepMeasure(winner.route_id, None, None, 0.0),
            )
    return winner, RankingStep.ROUTE_ID, drops


def rank_routes(candidates: Sequence[RouteCandidate], checkpoint_interval_miles: float) -> Ranking:
    """Rank one to three routes. The result does not depend on the order they are given in.

    Steps, in order: fewest No Travel miles; fewest Severe miles; High miles within one
    checkpoint interval of the best; average risk within the route's own tolerance of the best
    (one interval divided by its forecast miles, at most one level); shortest travel time;
    fewest miles; route id. Each tolerance is measured against the best route still in the
    contest at that step, so ties do not chain: adding a route can change the winner between
    two others. Second and third place repeat the steps without the routes already placed.

    A single route is first with no deciding step and no comparison; it is recommended unless it
    has No Travel miles.
    """
    if not 1 <= len(candidates) <= 3:
        raise ValueError(f"ranking takes one to three routes, got {len(candidates)}")
    if len({c.route_id for c in candidates}) != len(candidates):
        raise ValueError("route ids must be unique")
    if not math.isfinite(checkpoint_interval_miles) or checkpoint_interval_miles <= 0:
        raise ValueError("checkpoint_interval_miles must be a finite number above 0")
    for c in candidates:
        if not math.isfinite(c.travel_time_seconds) or c.travel_time_seconds < 0:
            raise ValueError(
                f"travel time of route {c.route_id!r} must be a finite number of at least 0"
            )

    remaining = list(candidates)
    ordered: list[RouteCandidate] = []
    decided_by: RankingStep | None = None
    first_round_drops: dict[str, tuple[RankingStep, StepMeasure]] = {}
    while remaining:
        if len(remaining) == 1:
            winner = remaining[0]
        else:
            winner, step, drops = _first_place(remaining, checkpoint_interval_miles)
            if not ordered:
                decided_by, first_round_drops = step, drops
        ordered.append(winner)
        remaining.remove(winner)

    first = ordered[0]
    ranked = []
    for rank, c in enumerate(ordered, start=1):
        comparison = None
        if rank > 1:
            average = (
                c.summary.average_risk - first.summary.average_risk
                if c.summary.average_risk is not None and first.summary.average_risk is not None
                else None
            )
            dropped_at, dropped_against = first_round_drops[c.route_id]
            comparison = RouteComparison(
                dropped_at=dropped_at,
                dropped_against=dropped_against,
                travel_time_seconds=c.travel_time_seconds - first.travel_time_seconds,
                no_travel_miles=c.summary.no_travel_miles - first.summary.no_travel_miles,
                severe_miles=c.summary.severe_miles - first.summary.severe_miles,
                high_miles=c.summary.high_miles - first.summary.high_miles,
                average_risk=average,
            )
        tolerance = (
            _average_risk_tolerance(c.summary, checkpoint_interval_miles)
            if c.summary.average_risk is not None
            else None
        )
        ranked.append(
            RankedRoute(c.route_id, rank, c.summary.no_forecast_miles, tolerance, comparison)
        )
    recommended = first.route_id if first.summary.no_travel_miles <= FLOAT_MARGIN else None
    return Ranking(tuple(ranked), recommended, decided_by)
