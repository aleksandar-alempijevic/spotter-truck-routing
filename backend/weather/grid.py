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

from routing.geo import EARTH_RADIUS_M, METERS_PER_MILE, Point

from .lattice import FORECAST_DEGREES, Cell, cell_center, forecast_cell

BLOCK = 5
"""Forecast cells per display cell along each axis. Odd, so a display cell's centre is the centre
of one forecast cell."""

CORRIDOR_MILES = 25.0
"""A display cell is in the corridor when its centre is within this distance of a route."""

DISPLAY_DEGREES = BLOCK * FORECAST_DEGREES

MILES_PER_DEGREE = math.radians(1) * EARTH_RADIUS_M / METERS_PER_MILE


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


def plan_locations(routes: Sequence[Sequence[Point]]) -> LocationPlan:
    """The forecast locations for routes given as their checkpoint positions."""
    checkpoint_cells = tuple(
        dict.fromkeys(forecast_cell(point) for points in routes for point in points)
    )
    blocks: dict[tuple[int, int], list[Cell]] = {}
    for cell in checkpoint_cells:
        blocks.setdefault((cell[0] // BLOCK, cell[1] // BLOCK), []).append(cell)

    grid = []
    for block in sorted(_corridor_blocks(routes)):
        center = _block_center_cell(block)
        held = blocks.get(block)
        source = min(held, key=lambda cell: (_distance2(cell, center), cell)) if held else center
        lat, lon = cell_center(center)
        grid.append(GridCell(block[0], block[1], lat, lon, source))

    known = set(checkpoint_cells)
    grid_only = sorted({cell.forecast for cell in grid} - known)
    return LocationPlan(checkpoint_cells, tuple(grid), tuple(grid_only))


def _block_center_cell(block: tuple[int, int]) -> Cell:
    return block[0] * BLOCK + BLOCK // 2, block[1] * BLOCK + BLOCK // 2


def _distance2(a: Cell, b: Cell) -> int:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def _corridor_blocks(routes: Sequence[Sequence[Point]]) -> set[tuple[int, int]]:
    found: set[tuple[int, int]] = set()
    lat_pad = CORRIDOR_MILES / MILES_PER_DEGREE
    for points in routes:
        for a, b in zip(points, points[1:] or points, strict=False):
            lat_lo, lat_hi = min(a[0], b[0]) - lat_pad, max(a[0], b[0]) + lat_pad
            widest = min(89.0, max(abs(a[0]), abs(b[0])) + lat_pad)
            lon_pad = lat_pad / math.cos(math.radians(widest))
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
                    if _miles_to_segment(center, a, b) <= CORRIDOR_MILES:
                        found.add((row, column))
    return found


def _miles_to_segment(p: Point, a: Point, b: Point) -> float:
    """Distance from p to the segment ab, on a plane fitted at p's latitude."""
    scale = math.cos(math.radians(p[0]))
    ax, ay = (a[1] - p[1]) * scale, a[0] - p[0]
    bx, by = (b[1] - p[1]) * scale, b[0] - p[0]
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy) * MILES_PER_DEGREE
