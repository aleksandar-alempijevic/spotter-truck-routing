"""Ranking two or three routes: safety first, with travel time deciding within forecast noise."""

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
class RouteComparison:
    """How a route differs from the recommended-order winner: its value minus the winner's."""

    dropped_at: RankingStep
    """The step at which the route left the contest for first place."""
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
    vs_first: RouteComparison | None
    """None for the first-ranked route."""


@dataclass(frozen=True, slots=True)
class Ranking:
    routes: tuple[RankedRoute, ...]
    """All routes, best first."""
    recommended_id: str | None
    """The first-ranked route, or None when it has No Travel miles."""
    decided_by: RankingStep
    """The step after which only the first-ranked route remained."""


def _within(
    candidates: list[RouteCandidate], value: Callable[[RouteCandidate], float], slack: float
):
    best = min(value(c) for c in candidates)
    return [c for c in candidates if value(c) <= best + slack + FLOAT_MARGIN]


def _average_risk_step(
    candidates: list[RouteCandidate], interval_miles: float
) -> list[RouteCandidate]:
    scored = [c for c in candidates if c.summary.average_risk is not None]
    if not scored:
        return candidates
    # A route with no average risk compares as worse than any number, so it is dropped here.
    # Each route has its own tolerance: one full-interval checkpoint moving one level shifts its
    # average by interval / its forecast miles. A route stays in if lowering its average by that
    # much would make it no worse than the best. Another route never changes this verdict.
    best = min(c.summary.average_risk for c in scored)
    return [
        c
        for c in scored
        if c.summary.average_risk - interval_miles / c.summary.forecast_miles <= best + FLOAT_MARGIN
    ]


def _steps(
    interval_miles: float,
) -> list[tuple[RankingStep, Callable[[list[RouteCandidate]], list[RouteCandidate]]]]:
    return [
        (RankingStep.NO_TRAVEL, lambda cs: _within(cs, lambda c: c.summary.no_travel_miles, 0)),
        (RankingStep.SEVERE, lambda cs: _within(cs, lambda c: c.summary.severe_miles, 0)),
        (RankingStep.HIGH, lambda cs: _within(cs, lambda c: c.summary.high_miles, interval_miles)),
        (RankingStep.AVERAGE_RISK, lambda cs: _average_risk_step(cs, interval_miles)),
        (RankingStep.TRAVEL_TIME, lambda cs: _within(cs, lambda c: c.travel_time_seconds, 0)),
        (RankingStep.MILES, lambda cs: _within(cs, lambda c: c.total_miles, 0)),
        (RankingStep.ROUTE_ID, lambda cs: [min(cs, key=lambda c: c.route_id)]),
    ]


def _first_place(
    candidates: list[RouteCandidate], interval_miles: float
) -> tuple[RouteCandidate, RankingStep, dict[str, RankingStep]]:
    """Filter step by step; return the winner, the deciding step and the step each loser left at."""
    survivors = candidates
    dropped_at: dict[str, RankingStep] = {}
    decided_by = RankingStep.ROUTE_ID
    for step, keep in _steps(interval_miles):
        kept = keep(survivors)
        for candidate in survivors:
            if candidate not in kept:
                dropped_at[candidate.route_id] = step
        survivors = kept
        if len(survivors) == 1:
            decided_by = step
            break
    return survivors[0], decided_by, dropped_at


def rank_routes(candidates: Sequence[RouteCandidate], checkpoint_interval_miles: float) -> Ranking:
    """Rank two or three routes. The result does not depend on the order they are given in.

    Steps, in order: fewest No Travel miles; fewest Severe miles; High miles within one
    checkpoint interval of the best; average risk within the route's own tolerance of the best
    (one interval divided by its forecast miles); shortest travel time; fewest
    miles; route id. Second and third place repeat the steps without the routes already placed.
    """
    if not 2 <= len(candidates) <= 3:
        raise ValueError(f"ranking takes two or three routes, got {len(candidates)}")
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
    decided_by = RankingStep.ROUTE_ID
    first_round_drops: dict[str, RankingStep] = {}
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
            comparison = RouteComparison(
                dropped_at=first_round_drops[c.route_id],
                travel_time_seconds=c.travel_time_seconds - first.travel_time_seconds,
                no_travel_miles=c.summary.no_travel_miles - first.summary.no_travel_miles,
                severe_miles=c.summary.severe_miles - first.summary.severe_miles,
                high_miles=c.summary.high_miles - first.summary.high_miles,
                average_risk=average,
            )
        ranked.append(RankedRoute(c.route_id, rank, c.summary.no_forecast_miles, comparison))
    recommended = first.route_id if first.summary.no_travel_miles <= FLOAT_MARGIN else None
    return Ranking(tuple(ranked), recommended, decided_by)
