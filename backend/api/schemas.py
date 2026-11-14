"""Wire schemas. Distances are in miles, load in pounds, and times are absolute instants."""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, Self

from ninja import Schema
from pydantic import AwareDatetime, Field, model_validator
from pydantic_core import PydanticCustomError

from risk_rules import Condition, Level, RankingStep
from routing.checkpoints import MARK_EPSILON_MILES
from routing.geo import METERS_PER_MILE, haversine_m
from routing.rest_breaks import StopKind
from routing.route import RouteSource
from weather import longitude_span_coverable

from .planner import ShortfallReason


def utc_now() -> datetime:
    """The instant the planning-window checks compare against: one place, so a test can fix it."""
    return datetime.now(UTC)


DEPARTURE_GRACE = timedelta(minutes=15)
"""A departure typed as "now" arrives slightly in the past; this much is accepted as given."""
DEPARTURE_HORIZON = timedelta(hours=48)
STOP_HORIZON = DEPARTURE_HORIZON + timedelta(days=30)
STOP_LOOKBACK = timedelta(days=30)
"""A checkpoint or a stop falls inside a trip that left within the departure window; no trip here
lasts 30 days, so the window runs from 30 days back to the departure horizon plus 30 days ahead.
It exists only to keep a time near year 9999 or year 1 from reaching the forecast code, where
adding a length or reading a stamp would overflow. It is wide on the past side on purpose: the
weather request is resent as it was for a retry, hours after the plan was made, and a plan that
is still open must not become an error. A time already past just has no forecast."""
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
    "outside_service_area",
    "too_many_locations",
]
"""Every `code` an error body can carry. A test ties each error class to this set."""

OUTSIDE_SERVICE_AREA: ErrorCode = "outside_service_area"
TOO_MANY_LOCATIONS: ErrorCode = "too_many_locations"
"""Validation error types that the API answers with a code of their own, because each needs
different advice from the person who sent the request (see `api/errors.py`)."""

MAX_CHECKPOINTS_PER_ROUTE = 600
"""The longest test route (about 3,560 miles) has 357 checkpoints at 10-mile spacing; this leaves
room for a route of about 6,000 miles."""
MAX_STOPS_PER_ROUTE = 100
MAX_STOP_SECONDS = 48 * 3600
MAX_ROUTE_SECONDS = 30 * 24 * 3600
"""No trip here lasts 30 days: the bound keeps a number a hand-built body can make huge out of
the ranking's arithmetic, where it would overflow into a 500."""
MAX_ROUTE_MILES = 30_000.0
"""Most that the schema's own limits can describe: 600 checkpoints at the widest spacing, 50 mi."""
"""The most stops a weather request may carry per route, and the longest one. A planned trip has
about 2 stops per 11 hours of driving, and the longest stop is a 34-hour restart."""
MAX_ID_LENGTH = 64
MAX_WEATHER_ROUTES = 3
SERVICE_LATITUDES = (15.0, 72.0)
SERVICE_LONGITUDES = (-170.0, -50.0)
"""The box the weather request's checkpoints must lie in: the contiguous US with its margin,
Alaska, Hawaii, Puerto Rico and the Canadian corridors a US-to-US truck route can cross. Outside
it the corridor sweep's planar and pole-and-antimeridian assumptions stop holding."""
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
    rest_breaks: bool = False
    """Add the federal rest breaks to the ETAs and the trip's duration. Omitted means off."""

    @model_validator(mode="after")
    def _check_trip(self) -> Self:
        if self.origin == self.destination:
            raise ValueError("origin and destination must be different points")
        now = utc_now()
        if not now - DEPARTURE_GRACE <= self.departure <= now + DEPARTURE_HORIZON:
            raise ValueError("departure must be between now and 48 hours from now")
        return self


class CheckpointOut(Schema):
    mile: float = Field(ge=0, le=MAX_ROUTE_MILES, allow_inf_nan=False)
    lat: Latitude
    lon: Longitude
    eta: AwareDatetime
    """UTC instant the truck reaches this mark. With rest breaks on it includes the stops before
    the mark; with them off it is driving time only."""


class StopCore(Schema):
    """A required stop as the weather request sends it back: where and when, to read its weather."""

    kind: StopKind
    """A 30-minute break, a 10-hour rest or a 34-hour restart."""
    mile: float = Field(ge=0, le=MAX_ROUTE_MILES, allow_inf_nan=False)
    lat: Latitude
    lon: Longitude
    starts_at: AwareDatetime
    duration_seconds: int = Field(gt=0, le=MAX_STOP_SECONDS)


class RouteCore(Schema):
    """The part of a route the weather request sends back; the line is never sent back."""

    id: str = Field(min_length=1, max_length=MAX_ID_LENGTH)
    travel_time_seconds: int = Field(ge=0, le=MAX_ROUTE_SECONDS)
    """Departure to arrival. With rest breaks on it includes the stops; with them off it is the
    driving time."""
    total_miles: float = Field(ge=0, le=MAX_ROUTE_MILES, allow_inf_nan=False)
    checkpoints: list[CheckpointOut] = Field(min_length=1, max_length=MAX_CHECKPOINTS_PER_ROUTE)
    stops: list[StopCore] = Field(default_factory=list, max_length=MAX_STOPS_PER_ROUTE)
    """The required stops in time order; empty with rest breaks off. Their weather is read, and
    they take no part in the route summary or the ranking."""


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
    driving_seconds: int
    stops: list[StopCore]
    """The required stops in order; empty with rest breaks off, and for a trip under 8 hours."""

    @staticmethod
    def resolve_travel_time_seconds(obj) -> int:
        return round(obj.route.travel_time_s + sum(stop.duration_seconds for stop in obj.stops))

    @staticmethod
    def resolve_driving_seconds(obj) -> int:
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
    breaks_applied: bool
    """Whether the ETAs include the federal rest breaks: the request's choice, echoed. A trip under
    8 hours has no stops either way, so empty `stops` cannot say which."""


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


def _check_service_area(points, what: str, where: str) -> None:
    if not all(
        SERVICE_LATITUDES[0] <= p.lat <= SERVICE_LATITUDES[1]
        and SERVICE_LONGITUDES[0] <= p.lon <= SERVICE_LONGITUDES[1]
        for p in points
    ):
        raise PydanticCustomError(
            OUTSIDE_SERVICE_AREA,
            f"{where}: {what} must lie in the service area (latitude "
            f"{SERVICE_LATITUDES[0]:g} to {SERVICE_LATITUDES[1]:g}, longitude "
            f"{SERVICE_LONGITUDES[0]:g} to {SERVICE_LONGITUDES[1]:g})",
        )


def _check_marks(route: RouteCore, interval_miles: float) -> None:
    marks = [checkpoint.mile for checkpoint in route.checkpoints]
    where = f"route {route.id!r}"
    _check_service_area(route.checkpoints, "checkpoints", where)
    _check_service_area(route.stops, "stops", where)
    if marks[0] != 0:
        raise ValueError(f"{where}: the first checkpoint must be at mile 0")
    if any(stop.mile > route.total_miles for stop in route.stops):
        raise ValueError(f"{where}: a stop lies beyond the end of the route")
    now = utc_now()
    window = (now - STOP_LOOKBACK, now + STOP_HORIZON)
    if any(not window[0] <= c.eta <= window[1] for c in route.checkpoints):
        raise ValueError(f"{where}: a checkpoint's eta is outside the planning window")
    if any(not window[0] <= stop.starts_at <= window[1] for stop in route.stops):
        raise ValueError(f"{where}: a stop starts outside the planning window")
    starts = [stop.starts_at for stop in route.stops]
    if starts != sorted(starts):
        raise ValueError(f"{where}: stops must be in time order")
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
        if straight / METERS_PER_MILE > allowed_miles or not longitude_span_coverable(
            (earlier.lat, earlier.lon), (later.lat, later.lon), allowed_miles
        ):
            raise ValueError(f"{where}: two checkpoints are farther apart than their miles allow")


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


class WeatherStopOut(Schema):
    """The weather a parked truck sits in: the worst the forecast gives over the stop, classified
    exactly as a checkpoint's is."""

    mile: float
    at: AwareDatetime | None
    """The instant within the stop whose conditions are shown; null when no forecast reaches it."""
    weather: ConditionsOut | None
    """Null when the forecast does not reach the stop; then `risk` is null too."""
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
    stops: list[WeatherStopOut]
    """One per stop of the request, in its order. Not part of the summary or the ranking."""
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
