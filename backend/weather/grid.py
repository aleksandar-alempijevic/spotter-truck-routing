"""The corridor grid and the forecast locations a request needs.

Two lattices. Forecasts are requested and cached on the forecast lattice (`lattice.py`). The
display lattice groups `BLOCK` x `BLOCK` forecast cells into one display cell (0.5 degrees, about
35 x 27 miles in the US), and the map shows one square per display cell inside the corridor. A
display cell that holds a checkpoint's forecast cell reads that forecast, so only cells with no
checkpoint in them add locations.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

from routing.geo import MILES_PER_DEGREE, Point, distance_to_segment_miles, longitude_degrees

from .lattice import FORECAST_DEGREES, Cell, cell_center, forecast_cell

BLOCK = 5
"""Forecast cells per display cell along each axis. Odd, so a display cell's centre is the centre
of one forecast cell."""

CORRIDOR_MILES = 25.0
"""A display cell is in the corridor when its centre is within this distance of a route."""

DISPLAY_DEGREES = BLOCK * FORECAST_DEGREES


class TooManyLocations(Exception):
    """A plan would pass the bound it was asked to stay within."""


@dataclass(frozen=True, slots=True)
class GridCell:
    row: int
    column: int
    """The display cell's position on the display lattice."""
    lat: float
    lon: float
    """The display cell's centre."""
    forecast: Cell
    """The forecast cell whose series colours this display cell."""


@dataclass(frozen=True, slots=True)
class LocationPlan:
    checkpoint_cells: tuple[Cell, ...]
    """Forecast cells holding a checkpoint, without repeats, in the order first met."""
    grid: tuple[GridCell, ...]
    """The corridor's display cells, in row then column order."""
    grid_only_cells: tuple[Cell, ...]
    """Forecast cells the grid needs that hold no checkpoint, sorted."""

    @property
    def cells(self) -> tuple[Cell, ...]:
        """Every forecast cell to fetch, checkpoint cells first."""
        return self.checkpoint_cells + self.grid_only_cells


def plan_locations(
    routes: Sequence[Sequence[Point]], *, max_locations: int | None = None
) -> LocationPlan:
    """The forecast locations for routes given as their checkpoint positions.

    Precondition: every position is on the map (latitude within ±90, longitude within ±180). The
    API's service box guarantees it for a weather request; a caller with other input must check it.

    With `max_locations`, `TooManyLocations` is raised when the plan's total (checkpoint cells
    plus grid-only cells) passes it. Two cheaper checks raise it earlier, as soon as the checkpoint
    cells or the corridor's display cells alone pass it. Both are lower bounds on the total: every
    display cell reads a forecast cell, and distinct display cells read distinct ones, so a
    corridor of more display cells than the bound already needs more locations than the bound.

    Planning stops at the bound, but the work before it stops is a sweep of each segment's
    bounding box. That is small for segments of road length (`longitude_span_coverable` is the
    check that keeps a segment's longitude span to what its miles cover), and not otherwise.
    """
    checkpoint_cells = tuple(
        dict.fromkeys(forecast_cell(point) for points in routes for point in points)
    )
    if max_locations is not None and len(checkpoint_cells) > max_locations:
        raise TooManyLocations
    blocks: dict[tuple[int, int], list[Cell]] = {}
    for cell in checkpoint_cells:
        blocks.setdefault((cell[0] // BLOCK, cell[1] // BLOCK), []).append(cell)

    grid = []
    for block in sorted(_corridor_blocks(routes, max_locations)):
        center = _block_center_cell(block)
        held = blocks.get(block)
        source = min(held, key=lambda cell: (_distance2(cell, center), cell)) if held else center
        lat, lon = cell_center(center)
        grid.append(GridCell(block[0], block[1], lat, lon, source))

    known = set(checkpoint_cells)
    grid_only = sorted({cell.forecast for cell in grid} - known)
    if max_locations is not None and len(checkpoint_cells) + len(grid_only) > max_locations:
        raise TooManyLocations
    return LocationPlan(checkpoint_cells, tuple(grid), tuple(grid_only))


def _block_center_cell(block: tuple[int, int]) -> Cell:
    return block[0] * BLOCK + BLOCK // 2, block[1] * BLOCK + BLOCK // 2


def _distance2(a: Cell, b: Cell) -> int:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def _corridor_blocks(routes: Sequence[Sequence[Point]], limit: int | None) -> set[tuple[int, int]]:
    found: set[tuple[int, int]] = set()
    lat_pad = CORRIDOR_MILES / MILES_PER_DEGREE
    for points in routes:
        for a, b in zip(points, points[1:] or points, strict=False):
            lat_lo, lat_hi = min(a[0], b[0]) - lat_pad, max(a[0], b[0]) + lat_pad
            lon_pad = longitude_degrees(CORRIDOR_MILES, max(abs(a[0]), abs(b[0])) + lat_pad)
            lon_lo, lon_hi = min(a[1], b[1]) - lon_pad, max(a[1], b[1]) + lon_pad
            for row in range(
                math.floor(lat_lo / DISPLAY_DEGREES), math.floor(lat_hi / DISPLAY_DEGREES) + 1
            ):
                for column in range(
                    math.floor(lon_lo / DISPLAY_DEGREES), math.floor(lon_hi / DISPLAY_DEGREES) + 1
                ):
                    if (row, column) in found:
                        continue
                    center = cell_center(_block_center_cell((row, column)))
                    if not (-90 <= center[0] <= 90 and -180 <= center[1] <= 180):
                        continue  # the unclamped centre is off the map: a pole or the antimeridian
                    if distance_to_segment_miles(center, a, b) <= CORRIDOR_MILES:
                        found.add((row, column))
                        if limit is not None and len(found) > limit:
                            raise TooManyLocations
    return found


def longitude_span_coverable(a: Point, b: Point, miles: float) -> bool:
    """Whether the longitudes of a and b differ by no more than `miles` of road can cover at their
    higher latitude. The corridor sweeps the planar box between the two longitudes, so a segment
    that is short on the ground but spans many degrees (across the antimeridian) fails this."""
    return abs(b[1] - a[1]) <= longitude_degrees(miles, max(abs(a[0]), abs(b[0])))
