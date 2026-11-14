"""The weather at each required stop: read like a checkpoint, worst over the stop, and kept out of
the summary and the ranking."""

from datetime import UTC, datetime, timedelta

import pytest

from api import weather_report
from tests import test_weather_api as weather_api
from tests.test_weather_api import HOUR, NOW, forecast, locations, post, request, route
from weather import ForecastCache

# The endpoint's clock, cache and sleep are replaced by autouse fixtures of the weather API tests;
# these tests run under the same ones.
clock = weather_api.clock
runtime = weather_api.runtime

# A route due north from (40, -100) with checkpoints at miles 0, 10 and 20; the stops below sit on
# it at mile 10 (the middle checkpoint's cell) unless a test moves them.
MIDDLE = (40.0 + 10 / 69.0, -100.0)


def stop(*, at=NOW, minutes=30, mile=10, lat=MIDDLE[0], lon=MIDDLE[1], kind="break") -> dict:
    return {
        "kind": kind,
        "mile": mile,
        "lat": lat,
        "lon": lon,
        "starts_at": at.isoformat(),
        "duration_seconds": minutes * 60,
    }


def with_stops(*stops: dict, **route_args) -> dict:
    return {**route(**route_args), "stops": list(stops)}


async def read(provider_mock, body, **weather):
    forecast(provider_mock, **weather)
    response = await post(body)
    assert response.status_code == 200, response.content[:300]
    return response.json()


async def test_the_request_carries_stops_and_the_answer_returns_one_reading_per_stop(
    provider_mock,
):
    first, second = stop(at=NOW, minutes=30), stop(at=NOW + timedelta(hours=3), minutes=600)

    body = await read(provider_mock, request(with_stops(first, second)))

    stops = body["routes"][0]["stops"]
    assert [s["mile"] for s in stops] == [10, 10]
    assert set(stops[0]) == {"mile", "at", "weather", "risk"}
    assert stops[0]["weather"]["wind_mph"] == 10.0
    assert stops[0]["risk"] == {"level": "low", "condition": None, "load_raised": False}


async def test_a_request_without_stops_gets_an_empty_list_for_every_route(provider_mock):
    body = await read(provider_mock, request(route("route-1"), route("route-2", lon=-99.0)))

    assert [r["stops"] for r in body["routes"]] == [[], []]


@pytest.mark.parametrize("load", [20_000, 35_000, 47_000])
@pytest.mark.parametrize(
    "wind", [10.0, 28.0, 38.0, 48.0, 60.0], ids=["low", "moderate", "high", "severe", "no travel"]
)
async def test_a_stop_is_read_exactly_as_a_checkpoint_at_the_same_place_and_time(
    provider_mock, load, wind
):
    # Checkpoint 2 is at mile 10 at NOW + 2 minutes; the stop is there at that instant for no time
    # worth of hours: its start and end are within the same hour, and the conditions are constant.
    at = NOW - timedelta(minutes=10) + timedelta(minutes=12)
    body = await read(
        provider_mock,
        request(with_stops(stop(at=at, minutes=1)), load=load),
        wind=lambda lat, lon, hour: wind,
    )

    checkpoint = body["routes"][0]["checkpoints"][1]
    reading = body["routes"][0]["stops"][0]
    assert reading["weather"] == checkpoint["weather"]
    assert reading["risk"] == checkpoint["risk"]


async def test_the_load_rules_apply_to_a_stop_like_to_a_checkpoint(provider_mock):
    # 38 mph is High; with more than 40,000 lb the load raises it to Severe.
    heavy = await read(
        provider_mock,
        request(with_stops(stop()), load=45_000),
        wind=lambda lat, lon, hour: 38.0,
    )

    assert heavy["routes"][0]["stops"][0]["risk"] == {
        "level": "severe",
        "condition": "wind",
        "load_raised": True,
    }


async def read_start_only(provider_mock) -> dict:
    """The reading of a one-minute stop at the long rest's start, in the same climbing wind."""
    body = await read(
        provider_mock,
        request(with_stops(stop(at=NOW, minutes=1)), load=20_000),
        wind=lambda lat, lon, hour: 9.0 + 6.0 * hour,
    )
    return body["routes"][0]["stops"][0]


async def test_a_long_stop_reads_the_worst_hour_it_spans_not_the_one_it_starts_in(provider_mock):
    # Wind climbs 6 mph an hour from 9: a 10-hour rest starting at NOW is calm when it starts and
    # No Travel before it ends. (`read_start_only` below reads the same place at the start alone.)
    rest = stop(at=NOW, minutes=600, kind="rest")

    body = await read(
        provider_mock,
        request(with_stops(rest), load=20_000),
        wind=lambda lat, lon, hour: 9.0 + 6.0 * hour,
    )

    reading = body["routes"][0]["stops"][0]
    assert reading["risk"]["level"] == "no_travel"
    # 9 + 6 * hour passes 55 mph at 22:00, and every later hour is No Travel too: the earliest wins.
    assert reading["at"] == (HOUR + timedelta(hours=8)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert reading["weather"]["wind_mph"] == 57.0
    # The same stop read at its start alone would have been Low.
    start = await read_start_only(provider_mock)
    assert start["risk"]["level"] == "low"


async def test_the_worst_reading_is_the_hour_with_the_highest_level_and_the_earliest_on_a_tie(
    provider_mock,
):
    # Calm, then a gale for two hours, then calm again: the worst is the gale's first sample.
    def wind(lat, lon, hour):
        return 60.0 if hour in (3, 4) else 5.0

    rest = stop(at=NOW, minutes=600, kind="rest")  # 14:20 to 00:20

    body = await read(provider_mock, request(with_stops(rest), load=20_000), wind=wind)

    reading = body["routes"][0]["stops"][0]
    assert reading["risk"]["level"] == "no_travel"
    assert reading["at"] == (HOUR + timedelta(hours=3)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )  # not the later hour at the same level


async def test_a_calm_stop_reads_its_start(provider_mock):
    rest = stop(at=NOW, minutes=600, kind="rest")

    body = await read(provider_mock, request(with_stops(rest)))

    assert body["routes"][0]["stops"][0]["at"] == NOW.isoformat().replace("+00:00", "Z")


async def test_a_stop_the_forecast_does_not_reach_has_no_weather_and_no_risk(provider_mock):
    late = stop(at=NOW + timedelta(hours=100), minutes=30)

    body = await read(provider_mock, request(with_stops(late)))

    assert body["routes"][0]["stops"][0] == {"mile": 10, "at": None, "weather": None, "risk": None}


async def test_a_stop_that_runs_past_the_forecast_reads_the_hours_it_has(provider_mock):
    straddling = stop(at=NOW + timedelta(hours=93), minutes=300, kind="rest")

    body = await read(provider_mock, request(with_stops(straddling)))

    reading = body["routes"][0]["stops"][0]
    assert reading["risk"]["level"] == "low"
    assert reading["at"] is not None


async def test_stops_change_neither_the_summary_nor_the_ranking_nor_the_grid(provider_mock):
    # The same three routes with and without stops, in a wind that is bad where the stops are.
    def routes(stops):
        return [{**route(f"route-{i + 1}", lon=-100.0 + i), "stops": stops(i)} for i in range(3)]

    def gale(lat, lon, hour):
        return 60.0 if hour >= 2 else 12.0

    forecast(provider_mock, wind=gale)
    bare = (await post(request(*routes(lambda i: [])))).json()
    stopped = (
        await post(
            request(
                *routes(
                    lambda i: [
                        stop(at=NOW + timedelta(hours=1), minutes=600, lon=-100.0 + i, kind="rest")
                    ]
                )
            )
        )
    ).json()

    assert all(r["stops"][0]["risk"]["level"] == "no_travel" for r in stopped["routes"])
    for with_stop, without in zip(stopped["routes"], bare["routes"], strict=True):
        assert with_stop["summary"] == without["summary"]
        assert with_stop["checkpoints"] == without["checkpoints"]
    assert stopped["ranking"] == bare["ranking"]
    assert stopped["grid"] == bare["grid"]
    assert stopped["departure"] == bare["departure"]


def fresh_cache(runtime):
    runtime.cache = ForecastCache(weather_report.MAX_CACHED_LOCATIONS)


async def test_a_stop_in_a_cell_a_checkpoint_holds_adds_no_forecast_location(
    provider_mock, runtime
):
    calls = forecast(provider_mock)
    await post(request(route()))
    base = locations(calls)
    calls.clear()
    fresh_cache(runtime)

    await post(request(with_stops(stop())))

    assert len(locations(calls)) == len(base)


async def test_a_stop_in_a_new_cell_adds_one_location_and_two_stops_there_add_one(
    provider_mock, runtime
):
    calls = forecast(provider_mock)
    await post(request(route()))
    base = len(locations(calls))
    calls.clear()
    fresh_cache(runtime)
    apart = {"lat": MIDDLE[0], "lon": -99.8}  # a cell no checkpoint holds

    await post(request(with_stops(stop(**apart), stop(at=NOW + timedelta(hours=1), **apart))))

    assert len(locations(calls)) == base + 1


async def test_stops_are_checked_against_the_service_box(provider_mock):
    calls = forecast(provider_mock)
    outside = stop(lat=10.0, lon=-100.0)  # south of latitude 15

    response = await post(request(with_stops(outside)))

    assert response.status_code == 422
    assert response.json()["code"] == "outside_service_area"
    assert "stops must lie in the service area" in response.json()["message"]
    assert calls == []


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(stop(mile=25), id="beyond the end of the route"),
        pytest.param(stop(minutes=0), id="no duration"),
        pytest.param({**stop(), "starts_at": "2026-11-13T14:20:00"}, id="naive start"),
        pytest.param({**stop(), "kind": "nap"}, id="unknown kind"),
        pytest.param(stop(minutes=49 * 60), id="longer than any stop"),
        pytest.param(stop(at=datetime(9999, 12, 31, tzinfo=UTC)), id="starts near year 9999"),
        pytest.param(stop(at=datetime(1, 1, 2, tzinfo=UTC)), id="starts in year 1"),
    ],
)
async def test_a_malformed_stop_is_a_422_before_any_forecast_call(provider_mock, bad):
    calls = forecast(provider_mock)

    response = await post(request(with_stops(bad)))

    assert response.status_code == 422
    assert set(response.json()) == {"code", "message"}
    assert calls == []


async def test_stops_out_of_time_order_are_a_422(provider_mock):
    calls = forecast(provider_mock)
    body = request(with_stops(stop(at=NOW + timedelta(hours=2)), stop(at=NOW + timedelta(hours=1))))

    response = await post(body)

    assert response.status_code == 422
    assert "time order" in response.json()["message"]
    assert calls == []


@pytest.mark.parametrize(
    "when",
    [datetime(9999, 12, 31, tzinfo=UTC), datetime(1, 1, 2, tzinfo=UTC)],
    ids=["year 9999", "year 1"],
)
async def test_a_checkpoint_eta_outside_the_planning_window_is_a_422_with_the_error_body(
    provider_mock, when
):
    calls = forecast(provider_mock)
    bad = route(etas=[when, when, when])

    response = await post(request(bad))

    assert response.status_code == 422
    assert set(response.json()) == {"code", "message"}
    assert response.json()["code"] == "validation_error"
    assert "planning window" in response.json()["message"]
    assert calls == []


async def test_a_plan_a_few_hours_old_can_still_be_sent_again_for_its_weather(provider_mock):
    # A retry resends the body of a plan left open: its checkpoint etas and its stop are hours in
    # the past by now, and that is no error. Nothing forecast reaches back that far.
    forecast(provider_mock)
    old = [NOW - timedelta(hours=6) + timedelta(minutes=12 * i) for i in range(3)]
    old_stop = stop(at=NOW - timedelta(hours=5), minutes=30)

    response = await post(request({**route(etas=old), "stops": [old_stop]}))

    assert response.status_code == 200, response.content[:300]
    reading = response.json()["routes"][0]["stops"][0]
    assert reading["weather"] is None


async def test_a_stop_mile_no_real_trip_reaches_is_a_422(provider_mock):
    calls = forecast(provider_mock)
    huge = {**stop(), "mile": 1e308}

    response = await post(request({**route(total=20), "stops": [huge]}))

    assert response.status_code == 422
    assert set(response.json()) == {"code", "message"}
    assert "less than or equal to" in response.json()["message"]  # its own field's bound
    assert calls == []
