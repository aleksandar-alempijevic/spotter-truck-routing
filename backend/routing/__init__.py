"""Pure route computations: checkpoints with ETAs, the rest-break rule, route overlap, via-city
candidates, line reduction and route ordering.

Standard library only, and independent of `risk_rules`. The API layer calls this package and the
providers return its `Route` type; it imports nothing else of ours. The package exports what the
other packages use; the rest is reached through its modules.
"""

from .checkpoints import RouteCheckpoint, build_checkpoints
from .geo import Point
from .ordering import order_routes
from .overlap import measure_overlap, near_cells
from .rest_breaks import RestStop, RouteStop, StopKind, locate_stops, plan_stops
from .route import Route, Via
from .simplify import simplify_line
from .via_cities import via_candidates

__all__ = [
    "Point",
    "RestStop",
    "Route",
    "RouteCheckpoint",
    "RouteStop",
    "StopKind",
    "Via",
    "build_checkpoints",
    "locate_stops",
    "measure_overlap",
    "near_cells",
    "order_routes",
    "plan_stops",
    "simplify_line",
    "via_candidates",
]
