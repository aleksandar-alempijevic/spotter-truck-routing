"""Wire schemas. Distances are in miles, load in pounds, and times are absolute instants."""

import math
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, Self

from ninja import Schema
from pydantic import AwareDatetime, Field, model_validator

from risk_rules import Condition, Level, RankingStep
from routing.checkpoints import MARK_EPSILON_MILES
from routing.geo import METERS_PER_MILE, MILES_PER_DEGREE, haversine_m
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
MAX_WEATHER_ROUTES = 3
GAP_DISTANCE_SLACK = 1.05
GAP_DISTANCE_SLACK_MILES = 0.25
"""Two consecutive checkpoints are never farther apart in a straight line than their mark gap;
these allow for rounding of the positions and for a polyline scaled to the reported length."""

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


# Shared: the address search carries Geoapify's credit and the weather response Open-Meteo's.
class AttributionOut(Schema):
    text: str
    url: str


class AddressSearchOut(Schema):
    suggestions: list[SuggestionOut]
    """US places of any type; empty when nothing matches."""
    attribution: AttributionOut
    """Geoapify's required credit, to be shown wherever the suggestions are."""


class WeatherIn(PlanParams):
    """The weather request: the routes response's send-back subset, flat. Extra fields (a
    route's line, source and via, the shortfall) are ignored."""

    routes: list[RouteCore] = Field(min_length=1, max_length=MAX_WEATHER_ROUTES)

    @model_validator(mode="after")
    def _check_routes(self) -> Self:
        """Reject what `risk_rules` would reject, plus bodies the planner cannot have made.

        The mark rules are at least as strict as `summarize_route`'s, which compares exactly.
        The gap checks run before any geometry or provider work, because the corridor walks
        every segment between consecutive checkpoints.
        """
        ids = [route.id for route in self.routes]
        if len(set(ids)) != len(ids):
            raise ValueError("route ids must be unique")
        for route in self.routes:
            _check_marks(route, self.checkpoint_interval_miles)
        return self


def _check_marks(route: RouteCore, interval_miles: float) -> None:
    marks = [checkpoint.mile for checkpoint in route.checkpoints]
    where = f"route {route.id!r}"
    if marks[0] != 0:
        raise ValueError(f"{where}: the first checkpoint must be at mile 0")
    if marks[-1] > route.total_miles:
        raise ValueError(f"{where}: a checkpoint lies beyond the end of the route")
    for earlier, later in zip(route.checkpoints, route.checkpoints[1:], strict=False):
        gap = later.mile - earlier.mile
        if gap <= 0:
            raise ValueError(f"{where}: checkpoint miles must be strictly ascending")
        if gap > interval_miles + MARK_EPSILON_MILES:
            raise ValueError(f"{where}: checkpoints are farther apart than the interval")
        allowed_miles = gap * GAP_DISTANCE_SLACK + GAP_DISTANCE_SLACK_MILES
        straight = haversine_m((earlier.lat, earlier.lon), (later.lat, later.lon))
        if straight / METERS_PER_MILE > allowed_miles or _longitude_jump_too_wide(
            earlier, later, allowed_miles
        ):
            raise ValueError(f"{where}: two checkpoints are farther apart than their miles allow")


def _longitude_jump_too_wide(earlier: CheckpointOut, later: CheckpointOut, miles: float) -> bool:
    """Whether the longitudes differ by more than `miles` can cover at the higher latitude.

    The straight-line check cannot see this across the antimeridian (-179.99 and 179.99 are a mile
    and a half apart), where the corridor's planar sweep would cross the whole map. Routes here
    stay in the US, so a crossing is never real.
    """
    cos_latitude = max(math.cos(math.radians(max(abs(earlier.lat), abs(later.lat)))), 0.0175)
    return abs(later.lon - earlier.lon) > miles / (MILES_PER_DEGREE * cos_latitude)


class ConditionsOut(Schema):
    """Forecast weather at a checkpoint's ETA. Gusts are shown, never classified."""

    wind_mph: float
    gust_mph: float
    rain_in_per_hr: float
    snow_in_per_hr: float


class RiskOut(Schema):
    level: Level
    condition: Condition | None
    """What decided the level; null at Low."""
    load_raised: bool
    """True when the load rules lifted the level above what the weather alone gives."""


class WeatherCheckpointOut(Schema):
    mile: float
    weather: ConditionsOut | None
    """Null when the forecast does not reach the ETA; then `risk` is null too."""
    risk: RiskOut | None


class RouteSummaryOut(Schema):
    low_miles: float
    moderate_miles: float
    high_miles: float
    severe_miles: float
    no_travel_miles: float
    no_forecast_miles: float
    """Miles whose checkpoint has no forecast; never counted as Low."""
    average_risk: float | None
    """Mile-weighted average of the level scores 0-4; null when no mile has a forecast."""


class WeatherRouteOut(Schema):
    id: str
    checkpoints: list[WeatherCheckpointOut]
    """In the request's order."""
    summary: RouteSummaryOut


class StepMeasureOut(Schema):
    best_route_id: str
    route_value: float | None
    best_value: float | None
    tolerance: float


class ComparisonOut(Schema):
    dropped_at: RankingStep
    dropped_against: StepMeasureOut
    travel_time_seconds: float
    no_travel_miles: float
    severe_miles: float
    high_miles: float
    average_risk: float | None


class RankedRouteOut(Schema):
    id: str
    rank: int
    no_forecast_miles: float
    average_risk_tolerance: float | None
    vs_first: ComparisonOut | None
    """What this route lost to the first-ranked one; null for the first."""

    @staticmethod
    def resolve_id(obj) -> str:
        return obj.route_id


class RankingOut(Schema):
    recommended_id: str | None
    """Null when the first-ranked route has No Travel miles."""
    decided_by: RankingStep | None
    """The step that left one route in first place; null for a one-route plan."""
    routes: list[RankedRouteOut]
    """Best first."""


class GridCellOut(Schema):
    lat: float
    lon: float
    """The cell's centre; its index in `cells` is its id."""
    levels: list[int | None]
    """One entry per hour from `grid.start`: an index into `level_codes`, null with no forecast."""


class GridOut(Schema):
    start: AwareDatetime
    """The top of the request's UTC hour: slider hour 0."""
    cell_degrees: float
    """Side of every cell in degrees; a cell is centred on its lat and lon."""
    level_codes: list[Level]
    cells: list[GridCellOut]


class WeatherOut(Schema):
    plan: PlanParams
    """The load and spacing the result was computed for."""
    departure: AwareDatetime
    """The earliest mile-0 ETA of the request's routes."""
    routes: list[WeatherRouteOut]
    ranking: RankingOut
    grid: GridOut
    attribution: AttributionOut
    """Open-Meteo's required credit, to be shown wherever the weather is."""
