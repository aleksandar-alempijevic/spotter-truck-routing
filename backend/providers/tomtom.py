"""TomTom Routing, truck mode: the only module that knows TomTom's URL and field names."""

import asyncio
from datetime import datetime
from typing import Annotated, Any, NotRequired, TypedDict

from pydantic import Field, TypeAdapter, ValidationError

from routing import Point, Route, Via
from routing.route import RouteContractError

from .errors import MalformedResponse, NoRouteFound, ProviderNotConfigured, ProviderUnavailable
from .outbound import Outbound, UpstreamBadRequest

CALCULATE_ROUTE_URL = "https://api.tomtom.com/routing/1/calculateRoute/{locations}/json"
CALL_TIMEOUT_S = 50.0
"""Long trips took up to 30 s to route in the feasibility test; this leaves room for a slow call."""

KILOGRAMS_PER_POUND = 0.45359237

EMPTY_RIG_LB = 33_000
"""Assumed weight of the empty tractor and trailer. The driver enters the cargo only; TomTom
checks the road's weight limits against the gross weight."""

CANADA = "CAN"
"""TomTom's ISO 3166-1 alpha-3 country code for Canada, as a country section reports it."""

NO_ROUTE_CODES = {"MAP_MATCHING_FAILURE", "NO_ROUTE_FOUND"}
"""TomTom's 400 error codes that mean the points cannot be joined by a road."""


Number = Annotated[float, Field(allow_inf_nan=False)]


class _Point(TypedDict):
    latitude: Number
    longitude: Number


class _Leg(TypedDict):
    points: list[_Point]


class _Instruction(TypedDict):
    routeOffsetInMeters: Number
    travelTimeInSeconds: Number


class _Guidance(TypedDict):
    instructions: Annotated[list[_Instruction], Field(min_length=1)]


class _Summary(TypedDict):
    lengthInMeters: Number
    travelTimeInSeconds: Number


class _Section(TypedDict):
    countryCode: NotRequired[str]


class _Route(TypedDict):
    sections: NotRequired[list[_Section]]
    summary: _Summary
    legs: list[_Leg]
    guidance: _Guidance


class _Response(TypedDict):
    routes: list[_Route]


_RESPONSE = TypeAdapter(_Response)


def pounds_to_kilograms(pounds: float) -> int:
    return round(pounds * KILOGRAMS_PER_POUND)


def gross_weight_kilograms(cargo_lb: float) -> int:
    return pounds_to_kilograms(cargo_lb + EMPTY_RIG_LB)


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

    Routes stay inside the US: the request asks TomTom to avoid border crossings, which it treats
    as a preference, so a route whose country sections include Canada is dropped here too.
    TomTom may return fewer routes than `alternatives` + 1. Raises `NoRouteFound` when it
    returns none, or only routes through Canada, and `MalformedResponse` when a route breaks the
    contract `routing.Route` needs.
    """
    if not api_key:
        raise ProviderNotConfigured
    waypoints = [origin, *([(via.lat, via.lon)] if via else []), destination]
    locations = ":".join(f"{lat:.5f},{lon:.5f}" for lat, lon in waypoints)
    params = {
        "key": api_key,
        "travelMode": "truck",
        "vehicleWeight": gross_weight_kilograms(load_lb),
        "avoid": "borderCrossings",
        "sectionType": "country",
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
        routes = await asyncio.to_thread(_parse_routes, body, via)
    except (ValidationError, RouteContractError):
        raise MalformedResponse from None
    if not routes:
        raise NoRouteFound
    return routes


def _error_code(body: Any) -> str:
    try:
        code = body["detailedError"]["code"]
    except (KeyError, TypeError):
        return ""
    return code if isinstance(code, str) else ""


def _parse_routes(body: Any, via: Via | None) -> list[Route]:
    """Validate TomTom's answer against the fields used, and build the routes.

    Runs in a thread: a long route has tens of thousands of points to validate and measure.
    Raises `ValidationError` for a body of the wrong shape and `RouteContractError` for a route
    that breaks the rules `routing.Route` enforces.
    """
    return [
        _build_route(route, via)
        for route in _RESPONSE.validate_python(body)["routes"]
        if not _enters_canada(route)
    ]


def _enters_canada(route: _Route) -> bool:
    return any(s.get("countryCode") == CANADA for s in route.get("sections", []))


def _build_route(route: _Route, via: Via | None) -> Route:
    points = tuple((p["latitude"], p["longitude"]) for leg in route["legs"] for p in leg["points"])
    knots = tuple(
        (i["routeOffsetInMeters"], i["travelTimeInSeconds"])
        for i in route["guidance"]["instructions"]
    )
    summary = route["summary"]
    return Route(points, summary["lengthInMeters"], summary["travelTimeInSeconds"], knots, via)
