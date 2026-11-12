"""Via-city candidates for a missing route, from a hand-kept list of US hubs.

A route forced through a city on another corridor is how a third route is made when the router
returns fewer. Candidates are chosen by geometry only; whether a candidate route is distinct
enough is decided afterwards by `overlap.is_distinct`. The list is data: extending it means
adding a row.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

from .geo import Point, haversine_m
from .route import Via

CITIES: dict[str, Point] = {
    "Albuquerque": (35.0844, -106.6504),
    "Amarillo": (35.2220, -101.8313),
    "Atlanta": (33.7490, -84.3880),
    "Billings": (45.7833, -108.5007),
    "Birmingham": (33.5186, -86.8104),
    "Boise": (43.6150, -116.2023),
    "Boston": (42.3601, -71.0589),
    "Charlotte": (35.2271, -80.8431),
    "Chicago": (41.8781, -87.6298),
    "Cheyenne": (41.1400, -104.8202),
    "Columbus": (39.9612, -82.9988),
    "Dallas": (32.7767, -96.7970),
    "Denver": (39.7392, -104.9903),
    "El Paso": (31.7619, -106.4850),
    "Fargo": (46.8772, -96.7898),
    "Houston": (29.7604, -95.3698),
    "Indianapolis": (39.7684, -86.1581),
    "Jacksonville": (30.3322, -81.6557),
    "Kansas City": (39.0997, -94.5786),
    "Las Vegas": (36.1699, -115.1398),
    "Little Rock": (34.7465, -92.2896),
    "Los Angeles": (34.0522, -118.2437),
    "Louisville": (38.2527, -85.7585),
    "Memphis": (35.1495, -90.0490),
    "Miami": (25.7617, -80.1918),
    "Minneapolis": (44.9778, -93.2650),
    "Nashville": (36.1627, -86.7816),
    "New Orleans": (29.9511, -90.0715),
    "New York": (40.7128, -74.0060),
    "Oklahoma City": (35.4676, -97.5164),
    "Omaha": (41.2565, -95.9345),
    "Philadelphia": (39.9526, -75.1652),
    "Phoenix": (33.4484, -112.0740),
    "Pittsburgh": (40.4406, -79.9959),
    "Portland": (45.5152, -122.6784),
    "Richmond": (37.5407, -77.4360),
    "Sacramento": (38.5816, -121.4944),
    "Salt Lake City": (40.7608, -111.8910),
    "San Antonio": (29.4241, -98.4936),
    "San Francisco": (37.7749, -122.4194),
    "Seattle": (47.6062, -122.3321),
    "Spokane": (47.6588, -117.4260),
    "St. Louis": (38.6270, -90.1994),
    "Tampa": (27.9506, -82.4572),
    "Washington DC": (38.9072, -77.0369),
}

MIN_ALONG, MAX_ALONG = 0.15, 0.85
"""How far along the origin-destination line a via-city must lie, as a share of it."""

MAX_DETOUR_RATIO = 1.30
"""Longest allowed crow-flies trip through the city, as a multiple of the direct distance."""

MIN_OFF_ROUTE_M = 120_000.0
"""A via-city must be at least this far from every route in hand, so it sits on another corridor."""

M_PER_DEGREE = 111_000.0
ROUTE_SAMPLE_POINTS = 1000
"""Each route is sampled to about this many points for the distance test."""

CANDIDATES_PER_SIDE = 3
"""How many cities on each side of the origin-destination line are offered, least detour first."""


@dataclass(frozen=True, slots=True)
class _Candidate:
    detour_ratio: float
    name: str


def _along_and_side(origin: Point, destination: Point, city: Point) -> tuple[float, int]:
    """Share of the way along origin-destination, and which side of that line the city is on."""
    k = math.cos(math.radians((origin[0] + destination[0]) / 2))
    vx, vy = (destination[1] - origin[1]) * k, destination[0] - origin[0]
    wx, wy = (city[1] - origin[1]) * k, city[0] - origin[0]
    along = (wx * vx + wy * vy) / (vx * vx + vy * vy)
    return along, 1 if vx * wy - vy * wx > 0 else -1


def _sample(route: Sequence[Point]) -> Sequence[Point]:
    return route[:: max(1, len(route) // ROUTE_SAMPLE_POINTS)]


def _off_route_m(city: Point, samples: Sequence[Point]) -> float:
    k = math.cos(math.radians(city[0]))
    return min(
        math.hypot((lat - city[0]) * M_PER_DEGREE, (lon - city[1]) * M_PER_DEGREE * k)
        for lat, lon in samples
    )


def via_candidates(
    origin: Point,
    destination: Point,
    routes: Sequence[Sequence[Point]],
    per_side: int = CANDIDATES_PER_SIDE,
) -> list[Via]:
    """Cities to route through, up to `per_side` on each side of the origin-destination line.

    A city qualifies when it lies between the two ends, adds at most 30% to the crow-flies
    distance and is at least 120 km from every route already in hand. Each side offers its
    cities least detour first. The result alternates between the sides, so the best city of each
    side comes before the second best of either.
    """
    direct = haversine_m(origin, destination)
    if direct <= 0:
        return []
    samples = [point for route in routes for point in _sample(route)]
    sides: dict[int, list[_Candidate]] = {1: [], -1: []}
    for name, city in CITIES.items():
        along, side = _along_and_side(origin, destination, city)
        if not MIN_ALONG <= along <= MAX_ALONG:
            continue
        detour = (haversine_m(origin, city) + haversine_m(city, destination)) / direct
        if detour > MAX_DETOUR_RATIO or _off_route_m(city, samples) < MIN_OFF_ROUTE_M:
            continue
        sides[side].append(_Candidate(detour, name))
    ranked = [
        sorted(found, key=lambda c: (c.detour_ratio, c.name))[:per_side] for found in sides.values()
    ]
    ranked.sort(key=lambda found: (found[0].detour_ratio, found[0].name) if found else (9, ""))
    names = [found[rank].name for rank in range(per_side) for found in ranked if rank < len(found)]
    return [Via(name, *CITIES[name]) for name in names]
