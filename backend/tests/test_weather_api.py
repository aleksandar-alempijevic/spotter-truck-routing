import asyncio
import json
import time
from collections.abc import Callable
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs

import httpx
import pytest
import respx
from django.test import AsyncClient

from api import api as api_module
from api import weather_report
from api.schemas import WeatherIn
from providers import openmeteo
from providers.errors import MalformedResponse
from providers.openmeteo import MAX_LOCATIONS_PER_CALL
from risk_rules import (
    Checkpoint,
    Level,
    summarize_route,
)
from tests.open_meteo_fixtures import location
from tests.test_routes_api import (
    KEY,
    MAIN,
    NORTH,
    SOUTH_ROUTE,
    mock_tomtom,
    via_returns,
)
from tests.test_routes_api import payload as routes_payload
from tests.test_routes_api import post as post_routes
from weather import ForecastCache, cell_center, forecast_cell, plan_locations, utc_hour

NOW = datetime(2026, 11, 13, 14, 20, tzinfo=UTC)
HOUR = utc_hour(NOW)


@pytest.fixture
def clock():
    """The deadline's clock in seconds: it moves only when the request sleeps."""
    return [1000.0]


@pytest.fixture(autouse=True)
def runtime(monkeypatch, clock):
    """The endpoint's clock, sleep and cache, replaced as one object: a fixed time, a fresh cache
    and a sleep that fails the test, so nothing really waits."""

    async def refuse(seconds):
        raise AssertionError(f"the request slept for {seconds} s")

    replacement = weather_report.Runtime(
        now=lambda: NOW,
        sleep=refuse,
        cache=ForecastCache(weather_report.MAX_CACHED_LOCATIONS),
        time=lambda: clock[0],
    )
    monkeypatch.setattr(api_module, "WEATHER_RUNTIME", replacement)
    return replacement


@pytest.fixture
def sleeps(runtime, clock):
    """Sleeps the request asks for. None really waits; each moves the deadline's clock."""
    asked: list[float] = []

    async def record(seconds):
        asked.append(seconds)
        clock[0] += seconds

    runtime.sleep = record
    return asked


def route(route_id="route-1", *, lat=40.0, lon=-100.0, marks=(0, 10, 20), total=None, etas=None):
    """A route due north from (lat, lon) with a checkpoint at each mark (69 miles to a degree)."""
    total = marks[-1] if total is None else total
    etas = etas or [NOW + timedelta(minutes=-10 + 12 * i) for i in range(len(marks))]
    return {
        "id": route_id,
        "travel_time_seconds": 3600,
        "total_miles": total,
        "checkpoints": [
            {"mile": m, "lat": lat + m / 69.0, "lon": lon, "eta": eta.isoformat()}
            for m, eta in zip(marks, etas, strict=True)
        ],
    }


def request(*routes, load=60_000, spacing=10):
    return {"load_lb": load, "checkpoint_interval_miles": spacing, "routes": list(routes)}


async def post(body):
    return await AsyncClient().post(
        "/api/weather", data=json.dumps(body), content_type="application/json"
    )


class Calls(list):
    """The calls made to the mocked Open-Meteo, each a list of (lat, lon); with its mock route and
    the function that answers it."""

    route: respx.Route
    answer: Callable[[httpx.Request], httpx.Response]


def forecast(
    provider_mock,
    *,
    wind=lambda lat, lon, hour: 10.0,
    gust=lambda lat, lon, hour: 15.0,
    precipitation=lambda lat, lon, hour: 0.0,
    snowfall=lambda lat, lon, hour: 0.0,
):
    """Answer Open-Meteo with a series per requested location, shaped by the given functions of
    the location and the hour index. Returns the list of calls, each a list of (lat, lon)."""
    calls = Calls()

    def answer(request: httpx.Request) -> httpx.Response:
        hour = utc_hour(api_module.WEATHER_RUNTIME.now())
        form = parse_qs(request.content.decode())
        lats = [float(v) for v in form["latitude"][0].split(",")]
        lons = [float(v) for v in form["longitude"][0].split(",")]
        calls.append(list(zip(lats, lons, strict=True)))
        stamps = [(hour + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(96)]
        bodies = [
            location(
                stamps,
                hourly={
                    "wind_speed_10m": [wind(lat, lon, i) for i in range(96)],
                    "wind_gusts_10m": [gust(lat, lon, i) for i in range(96)],
                    "precipitation": [precipitation(lat, lon, i) for i in range(96)],
                    "snowfall": [snowfall(lat, lon, i) for i in range(96)],
                },
            )
            for lat, lon in zip(lats, lons, strict=True)
        ]
        return httpx.Response(200, json=bodies[0] if len(bodies) == 1 else bodies)

    calls.route = provider_mock.post(host="api.open-meteo.com").mock(side_effect=answer)
    calls.answer = answer
    return calls


def locations(calls):
    return [point for call in calls for point in call]


async def test_the_response_has_every_part_the_ui_needs(provider_mock):
    forecast(provider_mock)

    response = await post(request(route("route-1"), route("route-2", lon=-99.0), spacing=10))
    body = response.json()

    assert response.status_code == 200
    assert body["plan"] == {"load_lb": 60_000, "checkpoint_interval_miles": 10}
    assert body["departure"] == (NOW - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
    assert [r["id"] for r in body["routes"]] == ["route-1", "route-2"]
    first = body["routes"][0]
    assert [c["mile"] for c in first["checkpoints"]] == [0, 10, 20]
    assert first["checkpoints"][0]["weather"] == {
        "wind_mph": 10.0,
        "gust_mph": 15.0,
        "rain_in_per_hr": 0.0,
        "snow_in_per_hr": 0.0,
    }
    assert first["checkpoints"][0]["risk"] == {
        "level": "low",
        "condition": None,
        "load_raised": False,
    }
    assert first["summary"] == {
        "low_miles": 20.0,
        "moderate_miles": 0.0,
        "high_miles": 0.0,
        "severe_miles": 0.0,
        "no_travel_miles": 0.0,
        "no_forecast_miles": 0.0,
        "average_risk": 0.0,
    }
    assert body["ranking"]["decided_by"] is not None
    assert [r["id"] for r in body["ranking"]["routes"]] == ["route-1", "route-2"]
    assert body["ranking"]["recommended_id"] == "route-1"
    assert body["attribution"] == {
        "text": "Weather data by Open-Meteo.com",
        "url": "https://open-meteo.com/",
    }


async def test_the_grid_has_a_level_for_each_of_49_hours_from_the_top_of_the_hour(provider_mock):
    # Wind equals the hour index, so the level at slider hour h is that of h mph.
    forecast(provider_mock, wind=lambda lat, lon, hour: float(hour))

    body = (await post(request(route(), load=20_000))).json()
    grid = body["grid"]

    assert grid["start"] == "2026-11-13T14:00:00Z"
    assert grid["cell_degrees"] == 0.5
    assert grid["level_codes"] == ["low", "moderate", "high", "severe", "no_travel"]
    assert grid["cells"]
    for cell in grid["cells"]:
        levels = cell["levels"]
        assert len(levels) == 49
        assert [levels[h] for h in (0, 24, 25, 34, 35, 44, 45, 48)] == [0, 0, 1, 1, 2, 2, 3, 3]


async def test_series_are_matched_to_checkpoints_by_position_in_the_call(provider_mock):
    # Each location's wind is its own latitude, so a mix-up between locations shows in the wind.
    calls = forecast(provider_mock, wind=lambda lat, lon, hour: lat)

    body = (await post(request(route(lat=30.0, marks=(0, 10, 20, 30, 40, 50))))).json()

    for checkpoint in body["routes"][0]["checkpoints"]:
        assert checkpoint["weather"]["wind_mph"] == pytest.approx(
            cell_center(forecast_cell((30.0 + checkpoint["mile"] / 69.0, -100.0)))[0], abs=0.01
        )
    assert calls and all(len(call) <= 150 for call in calls)


async def test_wind_is_interpolated_to_the_eta_and_an_early_eta_reads_the_first_stamp(
    provider_mock,
):
    forecast(provider_mock, wind=lambda lat, lon, hour: float(hour))
    etas = [HOUR - timedelta(minutes=30), HOUR + timedelta(minutes=90)]

    body = (await post(request(route(marks=(0, 10), etas=etas)))).json()
    first, second = body["routes"][0]["checkpoints"]

    assert first["weather"]["wind_mph"] == 0.0  # up to an hour before the first stamp
    assert second["weather"]["wind_mph"] == pytest.approx(1.5)


@pytest.mark.parametrize(
    ("load", "level", "raised"),
    [(40_000, "high", False), (40_001, "severe", True)],
)
async def test_the_load_rules_apply(provider_mock, load, level, raised):
    forecast(provider_mock, wind=lambda lat, lon, hour: 40.0)

    body = (await post(request(route(), load=load))).json()

    risk = body["routes"][0]["checkpoints"][0]["risk"]
    assert (risk["level"], risk["condition"], risk["load_raised"]) == (level, "wind", raised)
    assert body["grid"]["cells"][0]["levels"][0] == (3 if raised else 2)


async def test_gusts_are_shown_and_never_classified(provider_mock):
    forecast(provider_mock, gust=lambda lat, lon, hour: 80.0)

    checkpoint = (await post(request(route()))).json()["routes"][0]["checkpoints"][0]

    assert checkpoint["weather"]["gust_mph"] == 80.0
    assert checkpoint["risk"]["level"] == "low"


async def test_rain_is_precipitation_less_snow_water_and_snow_is_depth(provider_mock):
    forecast(
        provider_mock,
        precipitation=lambda lat, lon, hour: 0.7,
        snowfall=lambda lat, lon, hour: 2.8,  # 0.4 in of water
    )

    checkpoint = (await post(request(route()))).json()["routes"][0]["checkpoints"][0]

    assert checkpoint["weather"]["rain_in_per_hr"] == pytest.approx(0.3)
    assert checkpoint["weather"]["snow_in_per_hr"] == 2.8
    assert checkpoint["risk"]["level"] == "severe"
    assert checkpoint["risk"]["condition"] == "snow"


async def test_a_checkpoint_past_the_forecast_has_no_weather_and_no_level(provider_mock):
    forecast(provider_mock)
    etas = [NOW, NOW + timedelta(hours=200)]

    body = (await post(request(route(marks=(0, 10), total=30, etas=etas)))).json()
    first, second = body["routes"][0]["checkpoints"]

    assert first["risk"] is not None
    assert second["weather"] is None and second["risk"] is None
    summary = body["routes"][0]["summary"]
    assert (summary["low_miles"], summary["no_forecast_miles"]) == (10.0, 20.0)
    assert body["ranking"]["routes"][0]["no_forecast_miles"] == 20.0


async def test_a_route_with_no_forecast_at_all_has_no_average_and_is_recommended(provider_mock):
    forecast(provider_mock)
    etas = [NOW + timedelta(hours=200), NOW + timedelta(hours=201)]

    body = (await post(request(route(marks=(0, 10), etas=etas)))).json()

    assert body["routes"][0]["summary"]["average_risk"] is None
    assert body["ranking"]["routes"][0]["average_risk_tolerance"] is None
    assert body["ranking"]["recommended_id"] == "route-1"


async def test_a_one_route_plan_has_no_deciding_step_and_is_recommended(provider_mock):
    forecast(provider_mock)

    ranking = (await post(request(route()))).json()["ranking"]

    assert ranking["decided_by"] is None
    assert ranking["recommended_id"] == "route-1"
    assert ranking["routes"] == [
        {
            "id": "route-1",
            "rank": 1,
            "no_forecast_miles": 0.0,
            "average_risk_tolerance": 0.5,
            "vs_first": None,
        }
    ]


async def test_a_one_route_plan_with_no_travel_miles_is_not_recommended(provider_mock):
    forecast(provider_mock, wind=lambda lat, lon, hour: 60.0)

    ranking = (await post(request(route()))).json()["ranking"]

    assert ranking["recommended_id"] is None and ranking["decided_by"] is None


async def test_with_several_routes_the_ranking_comes_from_the_rules(provider_mock):
    # Route 2 runs through wind that is No Travel for the load; route 1 does not.
    forecast(provider_mock, wind=lambda lat, lon, hour: 60.0 if lon > -99.5 else 10.0)

    ranking = (
        await post(request(route("route-2", lon=-99.0), route("route-1", lon=-100.0)))
    ).json()["ranking"]

    assert ranking["recommended_id"] == "route-1"
    assert ranking["decided_by"] == "no_travel"
    assert [r["id"] for r in ranking["routes"]] == ["route-1", "route-2"]
    lost = ranking["routes"][1]["vs_first"]
    assert lost["dropped_at"] == "no_travel"
    assert lost["dropped_against"]["best_route_id"] == "route-1"
    assert lost["no_travel_miles"] == 20.0


async def test_a_repeated_request_fetches_nothing(provider_mock):
    calls = forecast(provider_mock)
    body = request(route(), route("route-2", lon=-99.0))

    first = await post(body)
    fetched = len(calls)
    second = await post(body)

    assert fetched > 0 and len(calls) == fetched
    assert second.json() == first.json()


async def test_a_new_hour_fetches_again(provider_mock, runtime):
    calls = forecast(provider_mock)
    await post(request(route()))
    fetched = len(calls)

    runtime.now = lambda: NOW + timedelta(hours=1)
    await post(request(route()))

    assert len(calls) == 2 * fetched


async def test_only_the_locations_not_cached_are_fetched(provider_mock):
    calls = forecast(provider_mock)
    await post(request(route(lat=40.0)))
    first = set(locations(calls))
    calls.clear()

    await post(request(route(lat=40.0), route("route-2", lat=45.0)))

    assert first.isdisjoint(locations(calls))
    assert locations(calls)


def long_trip():
    """Three routes of 1,500 miles a few degrees apart: about 450 checkpoint cells and a grid."""
    marks = tuple(range(0, 1501, 10))
    etas = [NOW] * len(marks)
    return request(
        *(
            route(f"route-{i}", lat=25.0, lon=-100.0 + 5 * i, marks=marks, etas=etas)
            for i in (1, 2, 3)
        )
    )


def planned_cells(body):
    positions = [[(c["lat"], c["lon"]) for c in r["checkpoints"]] for r in body["routes"]]
    return plan_locations(positions).cells


async def test_locations_go_out_in_chunks_of_at_most_150_with_no_repeats(provider_mock):
    calls = forecast(provider_mock)
    body = long_trip()

    response = await post(body)

    assert response.status_code == 200
    assert len(calls) == -(-len(planned_cells(body)) // 150) >= 3
    assert all(len(call) <= 150 for call in calls)
    assert sorted(locations(calls)) == sorted(cell_center(c) for c in planned_cells(body))


async def until(condition):
    """Let the event loop run (threads included) until the condition holds."""
    for _ in range(500_000):
        if condition():
            return
        await asyncio.sleep(0)
    assert condition()


def failing_second_chunk(calls, cells, release):
    """An Open-Meteo answer that fails the second chunk once `release()` holds, and answers the
    others normally. Returns the answer and the number of the others answered so far."""
    failing = f"{cell_center(cells[MAX_LOCATIONS_PER_CALL])[0]:.2f}"
    answered = []

    async def answer(request):
        first_latitude = parse_qs(request.content.decode())["latitude"][0].split(",")[0]
        if first_latitude == failing:
            await until(lambda: release(answered))
            return httpx.Response(500)
        answered.append(first_latitude)
        return calls.answer(request)

    return answer


async def test_a_chunk_that_fails_leaves_every_other_chunk_cached_for_the_retry(
    provider_mock, runtime
):
    calls = forecast(provider_mock)
    body = long_trip()
    cells = planned_cells(body)
    others = len(cells) - MAX_LOCATIONS_PER_CALL
    # Released once every other chunk is cached, so exactly those are cached when it fails.
    calls.route.mock(
        side_effect=failing_second_chunk(
            calls, cells, lambda answered: len(runtime.cache) == others
        )
    )

    failed = await post(body)

    assert failed.status_code == 502
    assert failed.json()["code"] == "provider_unavailable"
    cached = {cell for cell in cells if runtime.cache.get(cell, HOUR)}
    assert cached == set(cells[:MAX_LOCATIONS_PER_CALL]) | set(cells[2 * MAX_LOCATIONS_PER_CALL :])
    calls.route.mock(side_effect=calls.answer)
    calls.clear()

    retried = await post(body)

    assert retried.status_code == 200
    assert sorted(locations(calls)) == sorted(cell_center(c) for c in cells if c not in cached)


async def test_a_chunk_whose_response_arrived_is_cached_before_the_error_answer_goes_out(
    provider_mock, runtime, monkeypatch
):
    calls = forecast(provider_mock)
    real_parse = openmeteo.parse_forecasts

    def slow_parse(raw):
        time.sleep(0.05)  # in a worker thread: the failing chunk's error is ready long before
        return real_parse(raw)

    monkeypatch.setattr(openmeteo, "parse_forecasts", slow_parse)
    body = long_trip()
    cells = planned_cells(body)
    chunks = -(-len(cells) // MAX_LOCATIONS_PER_CALL)
    # The failing chunk fails as soon as every other response has arrived, before they are parsed.
    calls.route.mock(
        side_effect=failing_second_chunk(calls, cells, lambda answered: len(answered) == chunks - 1)
    )

    failed = await post(body)

    assert failed.status_code == 502
    cached = {cell for cell in cells if runtime.cache.get(cell, HOUR)}
    assert cached == set(cells[:MAX_LOCATIONS_PER_CALL]) | set(cells[2 * MAX_LOCATIONS_PER_CALL :])


async def test_a_parse_that_fails_after_the_request_already_failed_is_logged(
    provider_mock, monkeypatch, caplog
):
    calls = forecast(provider_mock)
    cells = planned_cells(long_trip())
    chunks = -(-len(cells) // MAX_LOCATIONS_PER_CALL)

    def failing_parse(raw):
        time.sleep(0.05)
        raise MalformedResponse

    monkeypatch.setattr(openmeteo, "parse_forecasts", failing_parse)
    calls.route.mock(
        side_effect=failing_second_chunk(calls, cells, lambda answered: len(answered) == chunks - 1)
    )

    with caplog.at_level("WARNING", logger="api.weather_report"):
        failed = await post(long_trip())

    assert failed.json()["code"] == "provider_unavailable"  # the chunk that failed first
    assert caplog.text.count("parsing a chunk failed: MalformedResponse") == chunks - 1


async def test_a_parse_failure_the_request_itself_raised_is_not_logged_again(
    provider_mock, monkeypatch, caplog
):
    forecast(provider_mock)
    monkeypatch.setattr(
        openmeteo, "parse_forecasts", lambda raw: (_ for _ in ()).throw(MalformedResponse())
    )

    with caplog.at_level("WARNING", logger="api.weather_report"):
        response = await post(request(route()))

    assert response.json()["code"] == "provider_malformed_response"
    assert "parsing a chunk failed" not in caplog.text


async def test_a_short_refusal_is_waited_out_and_the_request_succeeds(provider_mock, sleeps):
    calls = forecast(provider_mock)
    refusals = [httpx.Response(429, headers={"Retry-After": "30"})]
    calls.route.mock(side_effect=lambda r: refusals.pop() if refusals else calls.answer(r))

    response = await post(request(route()))

    assert response.status_code == 200
    assert sleeps == [31.0]


async def test_a_refusal_with_a_long_delay_is_a_503_at_once(provider_mock):
    provider_mock.post(host="api.open-meteo.com").respond(429, headers={"Retry-After": "3600"})

    response = await post(request(route()))

    assert response.status_code == 503
    assert response.json()["code"] == "provider_limited"


async def test_a_refusal_with_no_delay_is_a_503_at_once(provider_mock):
    provider_mock.post(host="api.open-meteo.com").respond(429)

    response = await post(request(route()))

    assert response.status_code == 503
    assert response.json()["code"] == "provider_limited"


async def test_a_wait_that_would_not_fit_the_deadline_is_a_503_without_sleeping_it(
    provider_mock, runtime
):
    provider_mock.post(host="api.open-meteo.com").respond(429, headers={"Retry-After": "60"})
    runtime.budget_s = 30.0  # the 61 s wait would end past the deadline; sleeping fails the test

    response = await post(request(route()))

    assert response.status_code == 503
    assert response.json()["code"] == "provider_limited"


async def test_a_second_wait_that_no_longer_fits_the_remaining_time_is_a_503(provider_mock, sleeps):
    provider_mock.post(host="api.open-meteo.com").respond(429, headers={"Retry-After": "60"})

    response = await post(request(route()))

    # 150 s of budget: waits of 61 s end at 61 and 122; a third would end at 183, so it is refused.
    assert sleeps == [61.0, 61.0]
    assert response.status_code == 503
    assert response.json()["code"] == "provider_limited"


async def test_a_chunk_is_refused_at_most_three_times_then_the_503_stands(provider_mock, sleeps):
    refused = provider_mock.post(host="api.open-meteo.com").respond(
        429, headers={"Retry-After": "5"}
    )

    response = await post(request(route()))

    assert sleeps == [6.0, 6.0, 6.0]
    assert refused.call_count == 4
    assert response.status_code == 503
    assert response.json()["code"] == "provider_limited"


async def test_a_call_that_times_out_twice_is_a_504(provider_mock):
    route_ = provider_mock.post(host="api.open-meteo.com").mock(side_effect=httpx.ReadTimeout("x"))

    response = await post(request(route()))

    assert route_.call_count == 2
    assert response.status_code == 504
    assert response.json()["code"] == "provider_timeout"


async def test_a_passed_deadline_is_a_504_and_nothing_is_cached(provider_mock, runtime):
    async def hang(request):
        await asyncio.sleep(30)

    provider_mock.post(host="api.open-meteo.com").mock(side_effect=hang)
    runtime.budget_s = 0.01

    response = await post(request(route()))

    assert response.status_code == 504
    assert len(runtime.cache) == 0


async def test_a_malformed_answer_is_a_502(provider_mock):
    provider_mock.post(host="api.open-meteo.com").respond(json={"hourly": {}})

    response = await post(request(route()))

    assert response.status_code == 502
    assert response.json()["code"] == "provider_malformed_response"


async def test_provider_failures_say_nothing_of_the_provider(provider_mock):
    provider_mock.post(host="api.open-meteo.com").respond(500, text="boom open-meteo.com")

    text = (await post(request(route()))).content.decode()

    assert "open-meteo" not in text.lower() and "boom" not in text


async def test_routes_that_need_too_many_locations_are_refused_before_any_call(
    provider_mock, runtime
):
    calls = forecast(provider_mock)
    runtime.max_locations = 5

    response = await post(request(route()))

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert "5 forecast locations" in response.json()["message"]
    assert calls == []


def edited(mutate):
    body = request(route("route-1"), route("route-2", lon=-99.0))
    mutate(body)
    return body


INVALID = {
    "no routes": lambda b: b.update(routes=[]),
    "four routes": lambda b: b["routes"].extend(
        [route("route-3", lon=-98.0), route("route-4", lon=-97.0)]
    ),
    "duplicate ids": lambda b: b["routes"][1].update(id="route-1"),
    "first mark not 0": lambda b: b["routes"][0]["checkpoints"][0].update(mile=1),
    "marks not ascending": lambda b: b["routes"][0]["checkpoints"][1].update(mile=0),
    "marks descending": lambda b: b["routes"][0]["checkpoints"][2].update(mile=5),
    "mark past the end": lambda b: b["routes"][0].update(total_miles=19.9),
    "marks farther apart than the interval": lambda b: b["routes"][0]["checkpoints"][1].update(
        mile=11, lat=40.0 + 11 / 69.0
    ),
    "positions farther apart than the miles": lambda b: b["routes"][0]["checkpoints"][1].update(
        lat=41.0
    ),
    "load zero": lambda b: b.update(load_lb=0),
    "load over the limit": lambda b: b.update(load_lb=80_001),
    "interval not offered": lambda b: b.update(checkpoint_interval_miles=30),
    "latitude out of range": lambda b: b["routes"][0]["checkpoints"][0].update(lat=91),
    "naive eta": lambda b: b["routes"][0]["checkpoints"][0].update(eta="2026-11-13T14:00:00"),
    "no checkpoints": lambda b: b["routes"][0].update(checkpoints=[]),
}


@pytest.mark.parametrize("mutate", INVALID.values(), ids=INVALID.keys())
async def test_a_body_that_breaks_the_send_back_rules_is_a_422_before_any_call(
    provider_mock, mutate
):
    calls = forecast(provider_mock)

    response = await post(edited(mutate))

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert calls == []


async def test_extra_fields_are_ignored(provider_mock):
    forecast(provider_mock)
    body = request(route())
    body["shortfall"] = None
    body["routes"][0].update(line=[[0, 0]], source="provider", via=None)

    assert (await post(body)).status_code == 200


# name: (marks, total miles, summarize_route rejects it, WeatherIn rejects it)
MARK_CASES = {
    "valid": ([0, 5, 10], 10, False, False),
    "last mark at the end": ([0, 10], 10, False, False),
    "last mark just past the end": ([0, 10.000001], 10, True, True),
    "last mark far past the end": ([0, 20], 10, True, True),
    "first mark not 0": ([1, 10], 10, True, True),
    "first mark just above 0": ([1e-9, 10], 10, True, True),
    "equal marks": ([0, 5, 5], 10, True, True),
    "descending marks": ([0, 8, 5], 10, True, True),
    "a single mark": ([0], 10, False, False),
    "a single mark at 0 on a zero-mile route": ([0], 0, False, False),
}
CASES = list(MARK_CASES.values())
IDS = list(MARK_CASES)


def rejection(rejected: bool):
    return pytest.raises(ValueError) if rejected else nullcontext()


@pytest.mark.parametrize(("marks", "total", "rules", "_"), CASES, ids=IDS)
def test_summarize_route_answers_the_table(marks, total, rules, _):
    with rejection(rules):
        summarize_route(total, [Checkpoint(mark, Level.LOW) for mark in marks])


@pytest.mark.parametrize(("marks", "total", "_", "schema"), CASES, ids=IDS)
def test_the_weather_request_answers_the_table(marks, total, _, schema):
    with rejection(schema):
        WeatherIn.model_validate(request(route(marks=tuple(marks), total=total), spacing=50))


@pytest.mark.parametrize(("marks", "total", "rules", "schema"), CASES, ids=IDS)
def test_the_weather_request_is_never_looser_than_the_rules(marks, total, rules, schema):
    assert schema >= rules


def alternating_across_the_antimeridian(count=600, same_point=False):
    """Checkpoints 10 miles apart by their marks that flip between lon -179.99 and 179.99, a mile
    and a half apart on the ground, as the planar corridor sweep sees the whole map between."""
    marks = tuple(range(0, 10 * count, 10))
    lat = (lambda i: 40.0) if same_point else (lambda i: 40.0 + 0.04 * i)
    result = route(marks=marks, etas=[NOW] * count)
    for i, checkpoint in enumerate(result["checkpoints"]):
        checkpoint.update(lat=lat(i), lon=-179.99 if i % 2 == 0 else 179.99)
    return result


@pytest.mark.parametrize("same_point", [False, True], ids=["stepping north", "the same two points"])
async def test_checkpoints_that_jump_across_the_antimeridian_are_a_422_before_any_planning(
    provider_mock, same_point
):
    calls = forecast(provider_mock)
    body = request(
        *(
            {**alternating_across_the_antimeridian(same_point=same_point), "id": f"route-{i}"}
            for i in (1, 2, 3)
        ),
        spacing=10,
    )

    response = await post(body)

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    # The service box rejects it first; the planning bound's message would read differently.
    assert "North America" in response.json()["message"]
    assert calls == []


def box_corner(lat=None, lon=None):
    """A body whose second checkpoint is moved to the given latitude or longitude."""

    def mutate(body):
        checkpoint = body["routes"][0]["checkpoints"][1]
        checkpoint.update(**({"lat": lat} if lat is not None else {"lon": lon}))

    return mutate


@pytest.mark.parametrize(
    "mutate",
    [box_corner(lat=72.1), box_corner(lat=23.9), box_corner(lon=-170.1), box_corner(lon=-49.9)],
    ids=["too far north", "too far south", "too far west", "too far east"],
)
async def test_checkpoints_outside_north_america_are_a_422_before_any_call(provider_mock, mutate):
    calls = forecast(provider_mock)
    body = request(route(lat=40.0, marks=(0, 10, 20)), spacing=10)
    mutate(body)

    response = await post(body)

    assert response.status_code == 422
    assert "latitude 24 to 72, longitude -170 to -50" in response.json()["message"]
    assert calls == []


@pytest.mark.parametrize(
    ("lat", "lon"), [(24.0, -100.0), (72.0, -100.0), (40.0, -170.0), (40.0, -50.0)]
)
def test_the_edges_of_the_service_box_are_inside_it(lat, lon):
    body = request(route(lat=lat, lon=lon, marks=(0,), etas=[NOW]), spacing=10)

    WeatherIn.model_validate(body)


def test_a_northern_route_with_wide_longitude_steps_is_accepted():
    # 50 miles at 64 degrees north is about 1.65 degrees of longitude.
    northern = route(lat=64.0, lon=-150.0, marks=(0, 50, 100), etas=[NOW] * 3)
    for i, checkpoint in enumerate(northern["checkpoints"]):
        checkpoint.update(lat=64.0, lon=-150.0 + 1.6 * i)

    WeatherIn.model_validate(request(northern, spacing=50))


@pytest.mark.parametrize("spacing", [10, 25, 50])
async def test_what_the_routes_endpoint_returns_is_accepted_as_it_is(
    provider_mock, runtime, spacing
):
    # Two provider routes and a via-city route, sent back unchanged: lines, sources and all.
    runtime.now = lambda: datetime.now(UTC)
    mock_tomtom(provider_mock, base=[MAIN, NORTH], via=via_returns({"Albuquerque": SOUTH_ROUTE}))
    routes_response = await post_routes(routes_payload(checkpoint_interval_miles=spacing))
    sent_back = routes_response.json()
    assert {r["source"] for r in sent_back["routes"]} == {"provider", "via_city"}
    calls = forecast(provider_mock)

    response = await post(sent_back)

    assert response.status_code == 200, response.content[:300]
    assert len(response.json()["routes"]) == 3
    assert KEY not in response.content.decode()
    assert locations(calls)
