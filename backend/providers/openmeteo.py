"""Open-Meteo hourly forecasts: the only module that knows Open-Meteo's URL, parameters, field
names, unit strings and snow ratio.

Open-Meteo needs no key, so there is no key setting and no not-configured error. Its free tier is
per IP: 600 locations a minute, 5,000 an hour and 10,000 a day, and a call of N locations costs N.
"""

import math
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from routing import Point
from weather import ForecastSeries

from .errors import MalformedResponse, ProviderUnavailable
from .outbound import Outbound, UpstreamBadRequest

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
CALL_TIMEOUT_S = 12.0
"""A call of 150 locations takes about half a second (measured in `live_weather_check.py`), so a
call still running after this is stuck; the weather request's own deadline bounds the rest."""
MAX_LOCATIONS_PER_CALL = 150
"""Chunk size: calls of 100 to 300 locations were reliable, and one of 1,000 took 61 s."""
FORECAST_HOURS = 96

USER_AGENT = "truck-route-weather"

ATTRIBUTION_TEXT = "Weather data by Open-Meteo.com"
ATTRIBUTION_URL = "https://open-meteo.com/"
"""What Open-Meteo's free tier (CC BY 4.0) requires to be shown next to its data."""

SNOW_TO_WATER = 7.0
"""Open-Meteo's `snowfall` is snow depth in inches; its water equivalent is a seventh of it."""

_FIELDS = ("wind_speed_10m", "wind_gusts_10m", "precipitation", "snowfall")
_UNITS = {
    "wind_speed_10m": "mp/h",
    "wind_gusts_10m": "mp/h",
    "precipitation": "inch",
    "snowfall": "inch",
}
"""The unit strings the call is observed to return; any other means the units are unknown."""


async def fetch_forecasts(outbound: Outbound, points: Sequence[Point]) -> list[ForecastSeries]:
    """One series per point, in the order of `points`, from one call of at most
    `MAX_LOCATIONS_PER_CALL` points.

    The provider snaps each coordinate to its own grid, so series are matched to points by
    position, never by the coordinates it echoes. Rain is precipitation less the water in the
    snow, never below 0. A null from the provider stays absent.
    """
    if not 1 <= len(points) <= MAX_LOCATIONS_PER_CALL:
        raise ValueError(f"a call takes 1 to {MAX_LOCATIONS_PER_CALL} points")
    form = {
        "hourly": ",".join(_FIELDS),
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
        "timezone": "UTC",
        "forecast_hours": FORECAST_HOURS,
        "models": "best_match",
        "latitude": ",".join(f"{lat:.2f}" for lat, _ in points),
        "longitude": ",".join(f"{lon:.2f}" for _, lon in points),
    }
    try:
        body = await outbound.post_form(
            FORECAST_URL, form, timeout=CALL_TIMEOUT_S, headers={"User-Agent": USER_AGENT}
        )
    except UpstreamBadRequest:
        raise ProviderUnavailable from None
    locations = body if isinstance(body, list) else [body]
    if len(locations) != len(points):
        raise MalformedResponse
    return [_parse(location) for location in locations]


def _parse(location: Any) -> ForecastSeries:
    if not isinstance(location, dict):
        raise MalformedResponse
    units, hourly = location.get("hourly_units"), location.get("hourly")
    if not isinstance(units, dict) or not isinstance(hourly, dict):
        raise MalformedResponse
    if any(units.get(field) != unit for field, unit in _UNITS.items()):
        raise MalformedResponse
    start = _hourly_start(hourly.get("time"))
    count = len(hourly["time"])
    columns = {field: _column(hourly.get(field), count) for field in _FIELDS}
    snow = columns["snowfall"]
    rain = tuple(
        None
        if precipitation is None or depth is None
        else max(0.0, precipitation - depth / SNOW_TO_WATER)
        for precipitation, depth in zip(columns["precipitation"], snow, strict=True)
    )
    return ForecastSeries(start, columns["wind_speed_10m"], columns["wind_gusts_10m"], rain, snow)


def _hourly_start(stamps: Any) -> datetime:
    """The first stamp, after checking that the stamps are consecutive hours.

    Open-Meteo answers naive ISO stamps in the requested time zone, which is UTC.
    """
    if not isinstance(stamps, list) or not stamps or not all(isinstance(s, str) for s in stamps):
        raise MalformedResponse
    try:
        parsed = [datetime.fromisoformat(stamp).replace(tzinfo=UTC) for stamp in stamps]
    except ValueError:
        raise MalformedResponse from None
    first = parsed[0]
    if (
        first.minute
        or first.second
        or any(stamp != first + timedelta(hours=i) for i, stamp in enumerate(parsed))
    ):
        raise MalformedResponse
    return first


def _column(values: Any, count: int) -> tuple[float | None, ...]:
    if not isinstance(values, list) or len(values) != count:
        raise MalformedResponse
    for value in values:
        if value is None:
            continue
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
        ):
            raise MalformedResponse
    return tuple(None if value is None else float(value) for value in values)
