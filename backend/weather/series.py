"""The hourly forecast of one location, and the conditions it gives at an instant."""

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

HOUR = timedelta(hours=1)


@dataclass(frozen=True, slots=True)
class ForecastSeries:
    """Hourly values from `start` (a UTC instant on the hour), one entry per hour.

    Wind is the instantaneous speed at the stamp. Gust, rain and snow describe the hour that ends
    at the stamp. Units are the assessment's: mph for wind and gust, inches per hour for rain and
    snow. A value is None when the provider has none for that hour; it is never read as zero.
    """

    start: datetime
    wind_mph: tuple[float | None, ...]
    gust_mph: tuple[float | None, ...]
    rain_in_per_hr: tuple[float | None, ...]
    snow_in_per_hr: tuple[float | None, ...]

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.start.utcoffset() != timedelta(0):
            raise ValueError("a series starts at a UTC instant")
        if self.start.minute or self.start.second or self.start.microsecond:
            raise ValueError("a series starts on the hour")
        hours = len(self.wind_mph)
        if hours == 0 or not (
            len(self.gust_mph) == len(self.rain_in_per_hr) == len(self.snow_in_per_hr) == hours
        ):
            raise ValueError("a series needs at least one hour, with every field the same length")


@dataclass(frozen=True, slots=True)
class Conditions:
    """The weather at one instant. Every field is present: absent data is no conditions."""

    wind_mph: float
    gust_mph: float
    rain_in_per_hr: float
    snow_in_per_hr: float


def utc_hour(instant: datetime) -> datetime:
    """The top of the UTC hour holding the instant."""
    return instant.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def instants_during(start: datetime, duration: timedelta) -> list[datetime]:
    """The instants a parked truck is read at: its start, every top of the UTC hour inside the
    stop, and its end, in order. A forecast stamp is an hour, so these are the readings the
    stop passes through; a stop shorter than an hour has its start and end.
    """
    end = start + duration
    instants = [start]
    tick = utc_hour(start) + HOUR
    while tick < end:
        instants.append(tick)
        tick += HOUR
    if end > start:
        instants.append(end)
    return instants


def conditions_at(series: ForecastSeries, instant: datetime) -> Conditions | None:
    """The conditions at `instant`, or None when the series gives no forecast for it.

    Stamps are matched by time, never by position in the caller's data. Wind is interpolated
    linearly between the stamps either side of the instant. Gust, rain and snow come from the
    first stamp at or after it, because each describes the hour before its stamp. An instant up
    to one hour before the first stamp reads the first stamp, which describes exactly that hour;
    an instant after the last stamp, or earlier than that, has no forecast. A value the instant
    needs that is absent gives no forecast.
    """
    if instant.tzinfo is None:
        raise ValueError("the instant must be timezone-aware")
    offset_h = (instant.astimezone(UTC) - series.start) / HOUR
    if offset_h < -1 or offset_h > len(series.wind_mph) - 1:
        return None
    after = max(0, math.ceil(offset_h))
    before = max(0, math.floor(offset_h))
    wind = series.wind_mph[before]
    if wind is not None and after != before:
        wind_after = series.wind_mph[after]
        if wind_after is None:
            return None
        wind += (wind_after - wind) * (offset_h - before)
    values = (
        wind,
        series.gust_mph[after],
        series.rain_in_per_hr[after],
        series.snow_in_per_hr[after],
    )
    if any(value is None for value in values):
        return None
    return Conditions(*values)


def conditions_by_hour(
    series: ForecastSeries, first: datetime, hours: int
) -> list[Conditions | None]:
    """`conditions_at` for `hours` consecutive whole hours from `first`, which must be on the
    hour. The series' stamps are whole hours too, so the offset between them is worked out once
    and each hour is a position in the series, with the same results (an hour that falls one
    before the first stamp reads the first stamp, and any other outside the series has no
    forecast)."""
    if first != utc_hour(first):
        raise ValueError("the first hour must be on the hour")
    shift = (first - series.start) // HOUR
    count = len(series.wind_mph)
    result: list[Conditions | None] = []
    for position in range(shift, shift + hours):
        if position < -1 or position >= count:
            result.append(None)
            continue
        i = max(0, position)
        values = (
            series.wind_mph[i],
            series.gust_mph[i],
            series.rain_in_per_hr[i],
            series.snow_in_per_hr[i],
        )
        result.append(None if None in values else Conditions(*values))
    return result
