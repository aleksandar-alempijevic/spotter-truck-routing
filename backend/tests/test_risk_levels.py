import math

import pytest

from risk_rules import Condition, Level, WeatherReading, classify_weather

L, M, H, S, N = Level.LOW, Level.MODERATE, Level.HIGH, Level.SEVERE, Level.NO_TRAVEL
LIGHT = 10_000.0


def level_of(wind=0.0, rain=0.0, snow=0.0, load=LIGHT) -> Level:
    return classify_weather(WeatherReading(wind, rain, snow), load).level


@pytest.mark.parametrize(
    ("wind", "expected"),
    [
        (0, L),
        (24.9, L),
        (25, M),
        (34.9, M),
        (35, H),
        (44.9, H),
        (45, S),
        (54.9, S),
        (55, N),
        (90, N),
    ],
)
def test_wind_bands_with_light_load(wind, expected):
    assert level_of(wind=wind) is expected


@pytest.mark.parametrize(
    ("rain", "expected"),
    [
        (0, L),
        (0.099, L),
        (0.10, M),
        (0.249, M),
        (0.25, H),
        (0.499, H),
        (0.50, S),
        (1.00, S),
        (1.001, N),
    ],
)
def test_rain_bands(rain, expected):
    assert level_of(rain=rain) is expected


@pytest.mark.parametrize(
    ("snow", "expected"),
    [(0, L), (0.49, L), (0.5, M), (0.99, M), (1.0, H), (1.99, H), (2.0, S), (3.0, S), (3.01, N)],
)
def test_snow_bands(snow, expected):
    assert level_of(snow=snow) is expected


def test_wind_55_is_no_travel_for_any_load():
    assert level_of(wind=55, load=0) is N
    assert level_of(wind=55, load=80_000) is N


@pytest.mark.parametrize(
    ("load", "expected"),
    [(30_000, S), (30_000.1, N), (80_000, N)],
)
def test_wind_45_to_54_above_30000_lb_is_no_travel(load, expected):
    assert level_of(wind=45, load=load) is expected
    assert level_of(wind=54.9, load=load) is expected


@pytest.mark.parametrize(
    ("load", "expected"),
    [(40_000, H), (40_000.1, S), (80_000, S)],
)
def test_wind_35_to_44_above_40000_lb_is_severe(load, expected):
    assert level_of(wind=35, load=load) is expected
    assert level_of(wind=44.9, load=load) is expected


def test_load_rules_do_not_apply_below_their_wind_bands():
    assert level_of(wind=34.9, load=80_000) is M
    assert level_of(wind=24.9, load=80_000) is L


def test_load_does_not_change_rain_or_snow():
    assert level_of(rain=0.25, load=80_000) is H
    assert level_of(snow=1.0, load=80_000) is H


def test_level_is_the_worst_of_the_three_conditions():
    assert level_of(wind=30, rain=0.3, snow=2.5) is S


def test_deciding_condition_is_named():
    assert classify_weather(WeatherReading(30, 0.3, 0.0), LIGHT).condition is Condition.RAIN
    assert classify_weather(WeatherReading(20, 0.0, 0.6), LIGHT).condition is Condition.SNOW
    assert classify_weather(WeatherReading(50, 0.0, 0.0), LIGHT).condition is Condition.WIND


def test_tie_between_conditions_names_wind_then_rain_then_snow():
    assert classify_weather(WeatherReading(40, 0.3, 1.5), LIGHT).condition is Condition.WIND
    assert classify_weather(WeatherReading(0, 0.3, 1.5), LIGHT).condition is Condition.RAIN
    assert classify_weather(WeatherReading(0, 0, 1.5), LIGHT).condition is Condition.SNOW


def test_all_low_reading_is_low():
    result = classify_weather(WeatherReading(0, 0, 0), LIGHT)
    assert (result.level, result.condition, result.load_raised) == (L, Condition.WIND, False)


def test_load_raised_is_reported_only_when_a_load_rule_changed_the_deciding_wind_level():
    heavy_wind = classify_weather(WeatherReading(40, 0, 0), 45_000)
    assert (heavy_wind.level, heavy_wind.load_raised) == (S, True)
    assert classify_weather(WeatherReading(50, 0, 0), 35_000).load_raised is True
    assert classify_weather(WeatherReading(40, 0, 0), LIGHT).load_raised is False
    # Wind 55 is No Travel without any load rule.
    assert classify_weather(WeatherReading(60, 0, 0), 80_000).load_raised is False
    # Rain is already Severe, so the load rule changed nothing and rain is named.
    rainy = classify_weather(WeatherReading(40, 0.8, 0), 45_000)
    assert (rainy.level, rainy.condition, rainy.load_raised) == (S, Condition.RAIN, False)
    # Rain is only High, so the load rule is what makes the checkpoint Severe.
    assert classify_weather(WeatherReading(40, 0.3, 0), 45_000).load_raised is True


def test_gusts_are_not_an_input():
    assert not hasattr(WeatherReading(0, 0, 0), "gust_mph")


@pytest.mark.parametrize("bad", [math.nan, math.inf, -0.1])
def test_invalid_readings_are_rejected(bad):
    with pytest.raises(ValueError):
        classify_weather(WeatherReading(bad, 0, 0), LIGHT)
    with pytest.raises(ValueError):
        classify_weather(WeatherReading(0, bad, 0), LIGHT)
    with pytest.raises(ValueError):
        classify_weather(WeatherReading(0, 0, bad), LIGHT)
    with pytest.raises(ValueError):
        classify_weather(WeatherReading(0, 0, 0), bad)


def test_levels_order_and_score():
    assert [level.score for level in (L, M, H, S, N)] == [0, 1, 2, 3, 4]
    assert L < M < H < S < N
    assert max(M, S) is S
    assert Level.NO_TRAVEL.value == "no_travel"
