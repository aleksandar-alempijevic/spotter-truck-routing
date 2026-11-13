"""Open-Meteo hourly forecasts: the only module that knows Open-Meteo's URL, parameters, field
names, unit strings and snow ratio.

Open-Meteo needs no key, so there is no key setting and no not-configured error. Its free tier is
per IP: 600 locations a minute, 5,000 an hour and 10,000 a day, and a call of N locations costs N.
"""

import asyncio
import math
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, NewType

from routing import Point
from weather import ForecastSeries

from .errors import MalformedResponse, ProviderUnavailable
from .outbound import Outbound, UpstreamBadRequest

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
CALL_TIMEOUT_S = 12.0
"""A call of 150 locations takes about half a second (measured in `live_weather_check.py`), so a
call still running after this is stuck; the weather request's own deadline bounds the rest."""
RATE_LIMIT_WINDOW_S = 60.0
LOCATIONS_PER_WINDOW = 600
"""The free tier's limit, per IP: this many locations in one window (a call of N locations costs
N), as well as 5,000 an hour and 10,000 a day. A refusal says how long is left in the window. A
paid key lifts these, so they are this module's to state."""
MAX_LOCATIONS_PER_CALL = 150
"""Chunk size: calls of 100 to 300 locations were reliable, and one of 1,000 took 61 s."""
FORECAST_HOURS = 96

USER_AGENT = "truck-route-weather"

ATTRIBUTION_TEXT = "Weather data by Open-Meteo.com"
ATTRIBUTION_URL = "https://open-meteo.com/"
"""What Open-Meteo's free tier (CC BY 4.0) requires to be shown next to its data."""

SNOW_TO_WATER = 7.0
"""Open-Meteo's `snowfall` is snow depth in inches; its water equivalent is a seventh of it."""

_UNITS = {
    "wind_speed_10m": "mp/h",
    "wind_gusts_10m": "mp/h",
    "precipitation": "inch",
    "snowfall": "inch",
}
"""The fields requested, with the unit strings the call is observed to return; any other unit
string means the units are unknown."""
_FIELDS = tuple(_UNITS)

RawForecasts = NewType("RawForecasts", list[Any])
"""A call's answers as received, before they are checked: what `request_forecasts` hands to
`parse_forecasts`. Nothing else should look inside."""


async def fetch_forecasts(outbound: Outbound, points: Sequence[Point]) -> list[ForecastSeries]:
    """One series per point, in the order of `points`, from one call of at most
    `MAX_LOCATIONS_PER_CALL` points: `request_forecasts`, then `parse_forecasts` off the event
    loop. A caller that must not lose a response that has arrived calls the two itself.

    The provider snaps each coordinate to its own grid, so series are matched to points by
    position, never by the coordinates it echoes. Rain is precipitation less the water in the
    snow, never below 0. A null from the provider stays absent.
    """
    return await asyncio.to_thread(parse_forecasts, await request_forecasts(outbound, points))


async def request_forecasts(outbound: Outbound, points: Sequence[Point]) -> RawForecasts:
    """The call itself: one raw location answer per point, in order, not yet checked or parsed.
    The answers are opaque to the caller: they are only for `parse_forecasts`.

    Raises the neutral errors, and `MalformedResponse` when the number of answers is wrong.
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
    return RawForecasts(locations)


def parse_forecasts(locations: RawForecasts) -> list[ForecastSeries]:
    """Check and convert the answers of `request_forecasts`. Real work for 150 locations of 96
    hours, so callers on the event loop run it in a thread."""
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

    Open-Meteo answers naive ISO stamps in the requested time zone, which is UTC. Only the first
    and last are parsed; the rest are checked by shape: the same length as the first (minute
    precision), on the hour and strictly ascending. Ascending whole hours that span exactly
    `len - 1` hours can only be consecutive.
    """
    if not isinstance(stamps, list) or not stamps or not all(isinstance(s, str) for s in stamps):
        raise MalformedResponse
    try:
        first = datetime.fromisoformat(stamps[0]).replace(tzinfo=UTC)
        last = datetime.fromisoformat(stamps[-1]).replace(tzinfo=UTC)
    except ValueError:
        raise MalformedResponse from None
    width = len(stamps[0])
    if (
        width != len("2026-11-13T14:00")
        or first.minute
        or last != first + timedelta(hours=len(stamps) - 1)
        or any(len(stamp) != width or not stamp.endswith(":00") for stamp in stamps)
        or any(earlier >= later for earlier, later in zip(stamps, stamps[1:], strict=False))
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
