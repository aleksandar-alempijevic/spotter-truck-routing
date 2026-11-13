"""The forecast lattice: 0.1 degree cells (about 7 miles), which forecasts are requested by."""

import math

from routing.geo import Point

FORECAST_DEGREES = 0.1
"""Cell size. Moving a point by this much changed a wind risk level in about 2% of hours."""

type Cell = tuple[int, int]
"""A forecast cell as (row, column) in units of `FORECAST_DEGREES`, row 0 starting at latitude 0."""


def forecast_cell(point: Point) -> Cell:
    """The cell holding the point. Rounding first keeps a point on an edge from falling short."""
    scale = 1 / FORECAST_DEGREES
    return math.floor(round(point[0] * scale, 6)), math.floor(round(point[1] * scale, 6))


def cell_center(cell: Cell) -> Point:
    """The point a cell's forecast is requested for."""
    row, column = cell
    return round((row + 0.5) * FORECAST_DEGREES, 6), round((column + 0.5) * FORECAST_DEGREES, 6)
