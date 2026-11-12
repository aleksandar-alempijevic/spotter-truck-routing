"""Wire schemas. Distances are in miles, load in pounds, and times are absolute instants."""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, Self

from ninja import Schema
from pydantic import AwareDatetime, Field, model_validator

from routing.route import RouteSource

from .planner import ShortfallReason

DEPARTURE_GRACE = timedelta(minutes=15)
"""A departure typed as "now" arrives slightly in the past; this much is accepted as given."""
DEPARTURE_HORIZON = timedelta(hours=48)
MAX_LOAD_LB = 80_000


ErrorCode = Literal[
    "validation_error",
    "not_found",
    "method_not_allowed",
    "internal_error",
    "no_route",
    "provider_timeout",
    "provider_unavailable",
    "provider_limited",
    "provider_not_configured",
    "provider_malformed_response",
    "provider_error",
]
"""Every `code` an error body can carry. A test ties each error class to this set."""

MAX_CHECKPOINTS_PER_ROUTE = 600
"""The longest test route (about 3,560 miles) has 357 checkpoints at 10-mile spacing; this leaves
room for a route of about 6,000 miles."""
MAX_ID_LENGTH = 64

Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]


class ErrorOut(Schema):
    code: ErrorCode
    message: str


class PointIn(Schema):
    lat: Latitude
    lon: Longitude


class PlanParams(Schema):
    """What a plan was made for, and what the weather request sends back with the routes."""

    load_lb: float = Field(gt=0, le=MAX_LOAD_LB, allow_inf_nan=False)
    checkpoint_interval_miles: Literal[10, 25, 50]


class RoutesIn(PlanParams):
    # The trip, on top of the plan parameters the request shares with the weather request.
    origin: PointIn
    destination: PointIn
    departure: AwareDatetime
    """When the truck leaves, with a UTC offset; from 15 minutes ago to 48 hours ahead."""

    @model_validator(mode="after")
    def _check_trip(self) -> Self:
        if self.origin == self.destination:
            raise ValueError("origin and destination must be different points")
        now = datetime.now(UTC)
        if not now - DEPARTURE_GRACE <= self.departure <= now + DEPARTURE_HORIZON:
            raise ValueError("departure must be between now and 48 hours from now")
        return self


class CheckpointOut(Schema):
    mile: float = Field(ge=0, allow_inf_nan=False)
    lat: Latitude
    lon: Longitude
    eta: AwareDatetime
    """UTC instant the truck reaches this mark, with no rest breaks."""


class RouteCore(Schema):
    """The part of a route the weather request sends back; the line is never sent back."""

    id: str = Field(min_length=1, max_length=MAX_ID_LENGTH)
    travel_time_seconds: int = Field(ge=0)
    total_miles: float = Field(ge=0, allow_inf_nan=False)
    checkpoints: list[CheckpointOut] = Field(min_length=1, max_length=MAX_CHECKPOINTS_PER_ROUTE)


class ViaOut(Schema):
    name: str
    lat: float
    lon: float


class RouteOut(RouteCore):
    # Built from the planner's `PlannedRoute`; the resolvers below read what its route holds. A
    # docstring would end up in the OpenAPI schema and the generated types.
    line: list[tuple[float, float]]
    """The route's line for the map as [lon, lat] pairs, reduced on the server."""
    source: RouteSource
    via: ViaOut | None

    @staticmethod
    def resolve_travel_time_seconds(obj) -> int:
        return round(obj.route.travel_time_s)

    @staticmethod
    def resolve_total_miles(obj) -> float:
        return obj.route.total_miles

    @staticmethod
    def resolve_line(obj) -> list[tuple[float, float]]:
        return [(lon, lat) for lat, lon in obj.line]

    @staticmethod
    def resolve_source(obj) -> RouteSource:
        return obj.route.source

    @staticmethod
    def resolve_via(obj):
        return obj.route.via


class ShortfallOut(Schema):
    reason: ShortfallReason
    message: str


class RoutesOut(PlanParams):
    routes: list[RouteOut]
    """One to three routes, fastest first; ids are numbered from that order."""
    shortfall: ShortfallOut | None
    """Set when fewer than three routes came back, with the reason."""


class SuggestionOut(Schema):
    label: str
    """The full text of the place, including its state."""
    lat: float
    lon: float
    timezone: str
    """IANA name of the place's time zone, for converting a typed departure time."""


class AttributionOut(Schema):
    text: str
    url: str


class AddressSearchOut(Schema):
    suggestions: list[SuggestionOut]
    """US places of any type; empty when nothing matches."""
    attribution: AttributionOut
    """Geoapify's required credit, to be shown wherever the suggestions are."""
