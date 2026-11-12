"""How much of one route runs along another, and whether a candidate is distinct enough."""

from collections.abc import Iterable, Sequence

from .geo import Point, haversine_m

CELL_DEGREES = 0.05
"""Grid cell size; a point counts as on a route when it is within a cell of one of its points."""

MAX_OVERLAP = 0.5
"""A via-city route is kept only if it overlaps every other route by less than this."""


def _cell(point: Point) -> tuple[int, int]:
    return round(point[0] / CELL_DEGREES), round(point[1] / CELL_DEGREES)


def near_cells(points: Iterable[Point]) -> set[tuple[int, int]]:
    """The cells holding a point of the route, and their eight neighbours (about 8 km)."""
    cells = set()
    for point in points:
        row, column = _cell(point)
        for d_row in (-1, 0, 1):
            for d_column in (-1, 0, 1):
                cells.add((row + d_row, column + d_column))
    return cells


def overlap_share(candidate: Sequence[Point], other_cells: set[tuple[int, int]]) -> float:
    """Share of the candidate's length that lies near the other route (0 apart, 1 the same road).

    One-directional on purpose: how much of the candidate is already covered by the other.
    """
    total = shared = 0.0
    for previous, current in zip(candidate, candidate[1:], strict=False):
        length = haversine_m(previous, current)
        total += length
        if _cell(current) in other_cells:
            shared += length
    return shared / total if total else 0.0


def worst_overlap(candidate: Sequence[Point], others: Iterable[Sequence[Point]]) -> float:
    """The largest overlap share of the candidate with any other route (0 when there are none)."""
    return max((overlap_share(candidate, near_cells(other)) for other in others), default=0.0)


def is_distinct(candidate: Sequence[Point], others: Iterable[Sequence[Point]]) -> bool:
    """True when the candidate overlaps every other route by less than `MAX_OVERLAP`."""
    return worst_overlap(candidate, others) < MAX_OVERLAP
