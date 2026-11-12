"""Pure route computations: checkpoints with ETAs, route overlap, via-city candidates, line
reduction and route ordering.

Standard library only, and independent of `risk_rules`. The API layer calls this package and the
providers return its `Route` type; it imports nothing else of ours.
"""

from .checkpoints import RouteCheckpoint, build_checkpoints, checkpoint_marks
from .geo import METERS_PER_MILE, Point, haversine_m
from .ordering import order_routes
from .overlap import MAX_OVERLAP, is_distinct, near_cells, overlap_share
from .route import Route, RouteContractError, Via
from .simplify import simplify_line
from .via_cities import CITIES, via_candidates

__all__ = [
    "CITIES",
    "MAX_OVERLAP",
    "METERS_PER_MILE",
    "Point",
    "Route",
    "RouteCheckpoint",
    "RouteContractError",
    "Via",
    "build_checkpoints",
    "checkpoint_marks",
    "haversine_m",
    "is_distinct",
    "near_cells",
    "order_routes",
    "overlap_share",
    "simplify_line",
    "via_candidates",
]
