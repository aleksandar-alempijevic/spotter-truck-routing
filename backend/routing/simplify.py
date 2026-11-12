"""Line reduction for the map."""

import math
from collections.abc import Sequence

from .geo import Point

DEFAULT_TOLERANCE_DEGREES = 0.001
"""About 100 m: a point is dropped when the line stays within this distance without it."""


def simplify_line(
    points: Sequence[Point], tolerance: float = DEFAULT_TOLERANCE_DEGREES
) -> list[Point]:
    """Douglas-Peucker reduction that keeps the first and last point.

    Distances are in degrees, with longitudes shrunk by the cosine of the line's mean latitude.
    """
    if len(points) <= 2:
        return list(points)
    lon_scale = math.cos(math.radians(sum(p[0] for p in points) / len(points)))
    ys = [p[0] for p in points]
    xs = [p[1] * lon_scale for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        ax, ay = xs[first], ys[first]
        dx, dy = xs[last] - ax, ys[last] - ay
        length_sq = dx * dx + dy * dy
        worst, worst_sq = -1, tolerance * tolerance
        for i in range(first + 1, last):
            px, py = xs[i] - ax, ys[i] - ay
            t = max(0.0, min(1.0, (px * dx + py * dy) / length_sq)) if length_sq else 0.0
            ex, ey = px - t * dx, py - t * dy
            distance_sq = ex * ex + ey * ey
            if distance_sq > worst_sq:
                worst, worst_sq = i, distance_sq
        if worst >= 0:
            keep[worst] = True
            stack.append((first, worst))
            stack.append((worst, last))
    return [p for p, kept in zip(points, keep, strict=True) if kept]
