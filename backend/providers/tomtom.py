"""TomTom Routing, truck mode: the only module that knows TomTom's URL and field names."""

from datetime import datetime
from typing import Any

from routing import Point, Route, Via

from .errors import MalformedResponse, NoRouteFound, ProviderNotConfigured, ProviderUnavailable
from .outbound import Outbound, UpstreamBadRequest

CALCULATE_ROUTE_URL = "https://api.tomtom.com/routing/1/calculateRoute/{locations}/json"
CALL_TIMEOUT_S = 50.0
"""Long trips took up to 30 s to route in the feasibility test; this leaves room for a slow call."""

KILOGRAMS_PER_POUND = 0.45359237

NO_ROUTE_CODES = {"MAP_MATCHING_FAILURE", "NO_ROUTE_FOUND"}
"""TomTom's 400 error codes that mean the points cannot be joined by a road."""


def pounds_to_kilograms(pounds: float) -> int:
    return round(pounds * KILOGRAMS_PER_POUND)


async def calculate_routes(
    outbound: Outbound,
    api_key: str,
    *,
    origin: Point,
    destination: Point,
    departure: datetime,
    load_lb: float,
    alternatives: int,
    via: Via | None = None,
) -> list[Route]:
    """Truck routes from origin to destination, optionally through one via point.

    TomTom may return fewer routes than `alternatives` + 1. Raises `NoRouteFound` when it
    returns none and `MalformedResponse` when a route breaks the contract `routing.Route` needs.
    """
    if not api_key:
        raise ProviderNotConfigured
    waypoints = [origin, *([(via.lat, via.lon)] if via else []), destination]
    locations = ":".join(f"{lat:.5f},{lon:.5f}" for lat, lon in waypoints)
    params = {
        "key": api_key,
        "travelMode": "truck",
        "vehicleWeight": pounds_to_kilograms(load_lb),
        "departAt": departure.isoformat(timespec="seconds"),
        "maxAlternatives": alternatives,
        "instructionsType": "coded",
        "routeType": "fastest",
        "traffic": "true",
    }
    try:
        body = await outbound.get_json(
            CALCULATE_ROUTE_URL.format(locations=locations), params, timeout=CALL_TIMEOUT_S
        )
    except UpstreamBadRequest as bad:
        if _error_code(bad.body) in NO_ROUTE_CODES:
            raise NoRouteFound from None
        raise ProviderUnavailable from None
    try:
        routes = body["routes"]
        if not routes:
            raise NoRouteFound
        return [_parse_route(route, via) for route in routes]
    except (KeyError, TypeError, ValueError, IndexError):
        # RouteContractError is a ValueError, so a route that breaks the contract lands here too.
        raise MalformedResponse from None


def _error_code(body: Any) -> str:
    try:
        code = body["detailedError"]["code"]
    except (KeyError, TypeError):
        return ""
    return code if isinstance(code, str) else ""


def _parse_route(route: dict[str, Any], via: Via | None) -> Route:
    summary = route["summary"]
    points = tuple(
        (float(p["latitude"]), float(p["longitude"]))
        for leg in route["legs"]
        for p in leg["points"]
    )
    knots = [
        (float(i["routeOffsetInMeters"]), float(i["travelTimeInSeconds"]))
        for i in route["guidance"]["instructions"]
    ]
    length_m = float(summary["lengthInMeters"])
    travel_time_s = float(summary["travelTimeInSeconds"])
    if knots[0][0] > 0:
        knots.insert(0, (0.0, 0.0))
    return Route(points, length_m, travel_time_s, tuple(knots), via)
