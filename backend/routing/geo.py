"""Distances on the Earth's surface."""

import math

EARTH_RADIUS_M = 6_371_000.0
METERS_PER_MILE = 1609.344

MILES_PER_DEGREE = math.radians(1) * EARTH_RADIUS_M / METERS_PER_MILE
"""Miles in one degree of latitude."""

type Point = tuple[float, float]
"""A position as (latitude, longitude) in degrees."""


def haversine_m(a: Point, b: Point) -> float:
    """Great-circle distance in metres between two points."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    half_dlat = (lat2 - lat1) / 2
    half_dlon = math.radians(b[1] - a[1]) / 2
    h = math.sin(half_dlat) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(half_dlon) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def distance_to_segment_miles(p: Point, a: Point, b: Point) -> float:
    """Distance in miles from p to the segment ab, on a plane fitted at p's latitude.

    Accurate for the tens of miles around p that a corridor needs, not for continental segments.
    """
    scale = math.cos(math.radians(p[0]))
    ax, ay = (a[1] - p[1]) * scale, a[0] - p[0]
    bx, by = (b[1] - p[1]) * scale, b[0] - p[0]
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy) * MILES_PER_DEGREE
