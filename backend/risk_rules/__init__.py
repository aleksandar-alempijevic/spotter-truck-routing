"""Weather risk levels, route summaries and route ranking.

Plain Python with no Django, Ninja or HTTP imports; the API layer calls this package, never the
other way round. See docs/logic.md for the rules.
"""

from .levels import (
    GUST_WARNING_MPH,
    Classification,
    Condition,
    Level,
    WeatherReading,
    classify_weather,
)
from .ranking import (
    FLOAT_MARGIN,
    RankedRoute,
    Ranking,
    RankingStep,
    RouteCandidate,
    RouteComparison,
    StepMeasure,
    rank_routes,
)
from .summary import Checkpoint, RouteSummary, summarize_route

__all__ = [
    "FLOAT_MARGIN",
    "GUST_WARNING_MPH",
    "Checkpoint",
    "Classification",
    "Condition",
    "Level",
    "RankedRoute",
    "Ranking",
    "RankingStep",
    "RouteCandidate",
    "RouteComparison",
    "RouteSummary",
    "StepMeasure",
    "WeatherReading",
    "classify_weather",
    "rank_routes",
    "summarize_route",
]
