from datetime import UTC, datetime, timedelta, timezone

import pytest

from weather import Conditions, ForecastSeries, conditions_at

START = datetime(2026, 11, 13, 14, 0, tzinfo=UTC)


def series(**overrides) -> ForecastSeries:
    fields = {
        "start": START,
        "wind_mph": (10.0, 20.0, 30.0),
        "gust_mph": (15.0, 25.0, 35.0),
        "rain_in_per_hr": (0.1, 0.2, 0.3),
        "snow_in_per_hr": (0.0, 0.5, 1.0),
    }
    return ForecastSeries(**{**fields, **overrides})


def at(minutes: float):
    return conditions_at(series(), START + timedelta(minutes=minutes))


def test_an_instant_on_a_stamp_reads_that_stamp():
    assert at(60) == Conditions(
        wind_mph=20.0, gust_mph=25.0, rain_in_per_hr=0.2, snow_in_per_hr=0.5
    )


def test_wind_is_interpolated_and_the_rest_reads_the_next_stamp():
    assert at(15) == Conditions(
        wind_mph=12.5, gust_mph=25.0, rain_in_per_hr=0.2, snow_in_per_hr=0.5
    )
    assert at(90) == Conditions(
        wind_mph=25.0, gust_mph=35.0, rain_in_per_hr=0.3, snow_in_per_hr=1.0
    )


def test_the_instant_is_matched_by_time_whatever_its_zone():
    belgrade = timezone(timedelta(hours=1))
    instant = datetime(2026, 11, 13, 15, 30, tzinfo=belgrade)  # 14:30 UTC

    assert conditions_at(series(), instant) == at(30)


def test_an_instant_up_to_an_hour_before_the_first_stamp_reads_the_first_stamp():
    assert at(-60) == Conditions(
        wind_mph=10.0, gust_mph=15.0, rain_in_per_hr=0.1, snow_in_per_hr=0.0
    )
    assert at(-1) == at(-60)
    assert at(-61) is None


def test_an_instant_after_the_last_stamp_has_no_forecast():
    assert at(120) is not None
    assert at(121) is None


@pytest.mark.parametrize(
    ("minutes", "overrides"),
    [
        pytest.param(30, {"wind_mph": (10.0, None, 30.0)}, id="wind after"),
        pytest.param(30, {"wind_mph": (None, 20.0, 30.0)}, id="wind before"),
        pytest.param(30, {"gust_mph": (15.0, None, 35.0)}, id="gust"),
        pytest.param(30, {"rain_in_per_hr": (0.1, None, 0.3)}, id="rain"),
        pytest.param(30, {"snow_in_per_hr": (0.0, None, 1.0)}, id="snow"),
        pytest.param(60, {"wind_mph": (10.0, None, 30.0)}, id="wind on the stamp"),
    ],
)
def test_a_needed_value_that_is_absent_means_no_forecast(minutes, overrides):
    assert conditions_at(series(**overrides), START + timedelta(minutes=minutes)) is None


def test_a_value_the_instant_does_not_need_may_be_absent():
    gaps = series(wind_mph=(10.0, 20.0, None), gust_mph=(None, 25.0, 35.0))

    assert conditions_at(gaps, START + timedelta(minutes=60)) is not None


def test_a_naive_instant_is_refused():
    with pytest.raises(ValueError):
        conditions_at(series(), datetime(2026, 11, 13, 14, 30))


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"start": datetime(2026, 11, 13, 14, 0)}, id="naive start"),
        pytest.param(
            {"start": datetime(2026, 11, 13, 15, 0, tzinfo=timezone(timedelta(hours=1)))},
            id="not UTC",
        ),
        pytest.param({"gust_mph": (1.0,)}, id="unequal lengths"),
        pytest.param(
            {
                "wind_mph": (),
                "gust_mph": (),
                "rain_in_per_hr": (),
                "snow_in_per_hr": (),
            },
            id="empty",
        ),
    ],
)
def test_a_series_must_be_utc_and_whole(overrides):
    with pytest.raises(ValueError):
        series(**overrides)
