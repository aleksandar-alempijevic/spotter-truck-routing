from datetime import UTC, datetime, timedelta, timezone

import pytest

from weather import (
    Conditions,
    ForecastSeries,
    conditions_at,
    conditions_by_hour,
    instants_during,
    utc_hour,
)

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
        pytest.param({"start": START + timedelta(minutes=30)}, id="off the hour"),
        pytest.param({"start": START + timedelta(microseconds=1)}, id="a microsecond off"),
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


def long_series(start: datetime, hours: int = 5) -> ForecastSeries:
    def column(scale, gap=None):
        return tuple(None if i == gap else scale * i for i in range(hours))

    return ForecastSeries(start, column(1.0), column(2.0, gap=3), column(0.01), column(0.5, gap=1))


@pytest.mark.parametrize("shift_hours", [-4, -2, -1, 0, 1, 3, 4, 6])
def test_sampling_by_hour_matches_sampling_by_instant(shift_hours):
    series = long_series(START)
    first = START + timedelta(hours=shift_hours)

    by_hour = conditions_by_hour(series, first, 8)

    assert by_hour == [conditions_at(series, first + timedelta(hours=h)) for h in range(8)]
    assert any(c is None for c in by_hour)


def test_sampling_by_hour_needs_a_first_hour_on_the_hour():
    with pytest.raises(ValueError):
        conditions_by_hour(series(), START + timedelta(minutes=20), 3)


def test_the_utc_hour_is_the_top_of_the_hour_in_utc():
    belgrade = timezone(timedelta(hours=1))

    assert utc_hour(datetime(2026, 11, 13, 15, 59, 59, 5, tzinfo=belgrade)) == START


def test_a_stop_is_read_at_its_start_every_top_of_the_hour_inside_it_and_its_end():
    start = START + timedelta(minutes=20)

    instants = instants_during(start, timedelta(hours=2, minutes=10))

    assert instants == [
        start,
        START + timedelta(hours=1),
        START + timedelta(hours=2),
        start + timedelta(hours=2, minutes=10),
    ]


def test_a_stop_inside_one_hour_is_read_at_its_start_and_end():
    start = START + timedelta(minutes=10)

    assert instants_during(start, timedelta(minutes=30)) == [start, start + timedelta(minutes=30)]


def test_a_stop_that_ends_on_the_hour_is_read_once_there_and_one_starting_on_it_is_not_doubled():
    assert instants_during(START, timedelta(hours=2)) == [
        START,
        START + timedelta(hours=1),
        START + timedelta(hours=2),
    ]


def test_hours_are_the_utc_hours_whatever_the_offset_of_the_instant_given():
    start = datetime(2026, 11, 13, 9, 20, tzinfo=timezone(timedelta(hours=-5)))

    instants = instants_during(start, timedelta(hours=2))

    assert [i.astimezone(UTC).minute for i in instants] == [20, 0, 0, 20]
