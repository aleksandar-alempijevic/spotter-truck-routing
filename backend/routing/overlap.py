"""How much of one route runs along another, and whether a candidate is distinct enough."""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .geo import Point, haversine_m

CELL_DEGREES = 0.05
"""Grid cell size; a point counts as on a route when it is within a cell of one of its points."""

MAX_OVERLAP = 0.5
"""A via-city route is kept only if it overlaps every other route by less than this."""


type Cells = set[tuple[int, int]]


@dataclass(frozen=True, slots=True)
class Overlap:
    share: float
    """The largest share of the candidate's length lying near any one other route."""
    distinct: bool
    """True when `share` is below `MAX_OVERLAP`: the candidate may join the routes in hand."""


def _cell(point: Point) -> tuple[int, int]:
    return round(point[0] / CELL_DEGREES), round(point[1] / CELL_DEGREES)


def near_cells(points: Iterable[Point]) -> Cells:
    """The cells holding a point of the route, and their eight neighbours (about 8 km)."""
    holding = {_cell(point) for point in points}
    return {
        (row + d_row, column + d_column)
        for row, column in holding
        for d_row in (-1, 0, 1)
        for d_column in (-1, 0, 1)
    }


def _share_near(candidate: Sequence[Point], cells: Cells) -> float:
    total = shared = 0.0
    for previous, current in zip(candidate, candidate[1:], strict=False):
        length = haversine_m(previous, current)
        total += length
        if _cell(current) in cells:
            shared += length
    return shared / total if total else 0.0


def measure_overlap(candidate: Sequence[Point], others: Iterable[Cells]) -> Overlap:
    """How much of the candidate runs along the other routes, given their `near_cells`.

    One-directional on purpose: how much of the candidate is already covered by a route (0 apart,
    1 the same road), taking the route that covers most. This is the only place the threshold is
    applied.
    """
    share = max((_share_near(candidate, cells) for cells in others), default=0.0)
    return Overlap(share, share < MAX_OVERLAP)
