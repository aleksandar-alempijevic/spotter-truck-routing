"""Line reduction for the map."""

import math
from collections.abc import Sequence

from .geo import Point

DEFAULT_TOLERANCE_DEGREES = 0.001
"""About 100 m: a point is dropped when the line stays within this distance without it."""


def _distance(p: Point, a: Point, b: Point, lon_scale: float) -> float:
    """Distance in degrees from p to the segment a-b, with longitudes shrunk by `lon_scale`."""
    ax, ay = a[1] * lon_scale, a[0]
    bx, by = b[1] * lon_scale, b[0]
    px, py = p[1] * lon_scale, p[0]
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify_line(
    points: Sequence[Point], tolerance: float = DEFAULT_TOLERANCE_DEGREES
) -> list[Point]:
    """Douglas-Peucker reduction that keeps the first and last point."""
    if len(points) <= 2:
        return list(points)
    lon_scale = math.cos(math.radians(sum(p[0] for p in points) / len(points)))
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        worst, worst_distance = -1, tolerance
        for i in range(first + 1, last):
            d = _distance(points[i], points[first], points[last], lon_scale)
            if d > worst_distance:
                worst, worst_distance = i, d
        if worst >= 0:
            keep[worst] = True
            stack.append((first, worst))
            stack.append((worst, last))
    return [p for p, kept in zip(points, keep, strict=True) if kept]
