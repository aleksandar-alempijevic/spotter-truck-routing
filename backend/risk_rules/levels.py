"""Risk levels and the per-checkpoint classification.

Units are the assessment's: sustained wind in mph, rain and snow in inches per hour, load in
pounds. Converting from a provider's fields to these units happens before this module is called.
"""

import math
from bisect import bisect_right
from dataclasses import dataclass
from enum import StrEnum


class Level(StrEnum):
    """A weather risk level. Members order by severity; the values are the wire names."""

    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    SEVERE = "severe"
    NO_TRAVEL = "no_travel"

    @property
    def score(self) -> int:
        """Weight in the average risk: Low 0, Moderate 1, High 2, Severe 3, No Travel 4."""
        return _ORDER.index(self)

    # Severity ordering. Equality and hashing stay those of the wire string, like the other enums.
    # Ordering against anything but a Level raises: returning NotImplemented would let Python
    # fall back to comparing the strings alphabetically.
    def __lt__(self, other: object) -> bool:
        return self.score < _score_of(other)

    def __le__(self, other: object) -> bool:
        return self.score <= _score_of(other)

    def __gt__(self, other: object) -> bool:
        return self.score > _score_of(other)

    def __ge__(self, other: object) -> bool:
        return self.score >= _score_of(other)


def _score_of(other: object) -> int:
    if not isinstance(other, Level):
        raise TypeError(f"levels order only against levels, not {type(other).__name__}")
    return other.score


_ORDER = list(Level)


class Condition(StrEnum):
    """The weather condition that decided a checkpoint's level."""

    WIND = "wind"
    RAIN = "rain"
    SNOW = "snow"


@dataclass(frozen=True, slots=True)
class WeatherReading:
    """Sustained wind (mph), rain rate (in/hr) and snow rate (in/hr) at one place and time.

    Gusts are not part of the reading: they are shown beside the level and never decide it.
    """

    wind_mph: float
    rain_in_per_hr: float
    snow_in_per_hr: float


@dataclass(frozen=True, slots=True)
class Classification:
    """The level of one checkpoint reading, with what decided it."""

    level: Level
    condition: Condition | None
    """The deciding condition; None at Low, where nothing decided the level."""
    load_raised: bool
    """True when a load rule lifted the level above what the weather alone gives."""


# Lower edges of the Moderate, High and Severe bands. A value on an edge belongs to the higher
# band. Wind's fourth edge is No Travel itself (>= 55 mph).
_WIND_SEVERE_EDGE = 45.0
_WIND_EDGES = (25.0, 35.0, _WIND_SEVERE_EDGE, 55.0)
GUST_WARNING_MPH = _WIND_SEVERE_EDGE
"""A gust at or above this (the Severe wind edge) gets a blow-over warning. It is shown beside the
level and never changes it: gusts are not part of the classification."""
_RAIN_EDGES = (0.10, 0.25, 0.50)
_SNOW_EDGES = (0.5, 1.0, 2.0)
# Rain and snow are No Travel only strictly above these values: exactly 1.00 in/hr rain and
# exactly 3.0 in/hr snow are Severe.
_RAIN_NO_TRAVEL_ABOVE = 1.00
_SNOW_NO_TRAVEL_ABOVE = 3.0

# Load rules, applied to wind only. Both weight limits are strict (">") and compare against the
# cargo weight, not the gross weight sent to the routing provider.
_HEAVY_WIND_MIN_LOAD_LB = 30_000.0  # wind in the Severe band, above this load: No Travel
_HIGH_WIND_MIN_LOAD_LB = 40_000.0  # wind in the High band, above this load: Severe


def _require_measurement(name: str, value: float) -> None:
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite number of at least 0, got {value!r}")


def _band(value: float, edges: tuple[float, ...], no_travel_above: float | None) -> Level:
    if no_travel_above is not None and value > no_travel_above:
        return Level.NO_TRAVEL
    return _ORDER[bisect_right(edges, value)]


def _wind_level(wind_mph: float, load_lb: float) -> Level:
    level = _band(wind_mph, _WIND_EDGES, None)
    if level is Level.SEVERE and load_lb > _HEAVY_WIND_MIN_LOAD_LB:
        return Level.NO_TRAVEL
    if level is Level.HIGH and load_lb > _HIGH_WIND_MIN_LOAD_LB:
        return Level.SEVERE
    return level


def classify_weather(reading: WeatherReading, load_lb: float) -> Classification:
    """Classify one reading for a load.

    The level is the worst of wind, rain and snow. When several conditions share the worst level,
    wind is named before rain and rain before snow; at Low no condition is named. `load_raised`
    is true when a load rule lifted the level above what the weather alone gives; the deciding
    condition is then wind.

    Every field must be a finite number of at least 0. A missing forecast is the caller's to
    represent as an absent level, never as a number.
    """
    _require_measurement("wind_mph", reading.wind_mph)
    _require_measurement("rain_in_per_hr", reading.rain_in_per_hr)
    _require_measurement("snow_in_per_hr", reading.snow_in_per_hr)
    _require_measurement("load_lb", load_lb)

    unloaded = (
        (Condition.WIND, _band(reading.wind_mph, _WIND_EDGES, None)),
        (Condition.RAIN, _band(reading.rain_in_per_hr, _RAIN_EDGES, _RAIN_NO_TRAVEL_ABOVE)),
        (Condition.SNOW, _band(reading.snow_in_per_hr, _SNOW_EDGES, _SNOW_NO_TRAVEL_ABOVE)),
    )
    # max() returns the first of equal items, which gives the wind, rain, snow precedence.
    condition, level = max(unloaded, key=lambda pair: pair[1])

    loaded_wind = _wind_level(reading.wind_mph, load_lb)
    if loaded_wind > level:
        return Classification(level=loaded_wind, condition=Condition.WIND, load_raised=True)
    return Classification(
        level=level, condition=None if level is Level.LOW else condition, load_raised=False
    )
