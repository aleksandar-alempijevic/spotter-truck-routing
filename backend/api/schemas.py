"""Wire schemas. Distances are in miles, load in pounds, and times are absolute instants."""

from datetime import UTC, datetime, timedelta
from typing import Literal, Self

from ninja import Schema
from pydantic import AwareDatetime, Field, model_validator

DEPARTURE_GRACE = timedelta(minutes=15)
"""A departure typed as "now" arrives slightly in the past; this much is accepted as given."""
DEPARTURE_HORIZON = timedelta(hours=48)
MAX_LOAD_LB = 80_000


ErrorCode = Literal[
    "validation_error",
    "no_route",
    "provider_timeout",
    "provider_unavailable",
    "provider_limited",
    "provider_not_configured",
    "provider_malformed_response",
    "provider_error",
]
"""Every `code` an error body can carry. A test ties each error class to this set."""


class ErrorOut(Schema):
    code: ErrorCode
    message: str


class PointIn(Schema):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)


class RoutesIn(Schema):
    origin: PointIn
    destination: PointIn
    departure: AwareDatetime
    """When the truck leaves, with a UTC offset; from 15 minutes ago to 48 hours ahead."""
    load_lb: float = Field(gt=0, le=MAX_LOAD_LB, allow_inf_nan=False)
    checkpoint_interval_miles: Literal[10, 25, 50]

    @model_validator(mode="after")
    def _check_trip(self) -> Self:
        if self.origin == self.destination:
            raise ValueError("origin and destination must be different points")
        now = datetime.now(UTC)
        if not now - DEPARTURE_GRACE <= self.departure <= now + DEPARTURE_HORIZON:
            raise ValueError("departure must be between now and 48 hours from now")
        return self


class PlanParams(Schema):
    """What a plan was made for, and what the weather request sends back with the routes."""

    load_lb: float
    checkpoint_interval_miles: Literal[10, 25, 50]


class CheckpointOut(Schema):
    mile: float
    lat: float
    lon: float
    eta: datetime
    """UTC instant the truck reaches this mark, with no rest breaks."""


class RouteCore(Schema):
    """The part of a route the weather request sends back; the line is never sent back."""

    id: str
    travel_time_seconds: int
    total_miles: float
    checkpoints: list[CheckpointOut]


class ViaOut(Schema):
    name: str
    lat: float
    lon: float


class RouteOut(RouteCore):
    line: list[tuple[float, float]]
    """The route's line for the map as [lon, lat] pairs, reduced on the server."""
    source: Literal["provider", "via_city"]
    via: ViaOut | None


class ShortfallOut(Schema):
    reason: Literal["no_distinct_alternative", "fill_incomplete"]
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
