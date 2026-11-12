"""Distances on the Earth's surface."""

import math

EARTH_RADIUS_M = 6_371_000.0
METERS_PER_MILE = 1609.344

type Point = tuple[float, float]
"""A position as (latitude, longitude) in degrees."""


def haversine_m(a: Point, b: Point) -> float:
    """Great-circle distance in metres between two points."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    half_dlat = (lat2 - lat1) / 2
    half_dlon = math.radians(b[1] - a[1]) / 2
    h = math.sin(half_dlat) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(half_dlon) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))
