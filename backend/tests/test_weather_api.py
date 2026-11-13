import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs

import httpx
import pytest
import respx
from django.test import AsyncClient

from api import weather_report
from api.schemas import WeatherIn
from risk_rules import (
    FLOAT_MARGIN,
    Checkpoint,
    Level,
    RouteCandidate,
    RouteSummary,
    rank_routes,
    summarize_route,
)
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
from weather import cell_center, forecast_cell, plan_locations

NOW = datetime(2026, 11, 13, 14, 20, tzinfo=UTC)
HOUR = NOW.replace(minute=0)


@pytest.fixture(autouse=True)
def fixed_now(monkeypatch):
    monkeypatch.setattr(weather_report, "_now", lambda: NOW)


@pytest.fixture(autouse=True)
def no_real_sleep(monkeypatch):
    async def refuse(seconds):
        raise AssertionError(f"the request slept for {seconds} s")

    monkeypatch.setattr(weather_report, "_sleep", refuse)


@pytest.fixture
def fake_clock(monkeypatch):
    """Time that moves only when the request sleeps; nothing really waits."""

    class Clock:
        now = 1000.0
        sleeps: list[float] = []

    async def sleep(seconds):
        Clock.sleeps.append(seconds)
        Clock.now += seconds

    Clock.sleeps = []
    monkeypatch.setattr(weather_report, "_monotonic", lambda: Clock.now)
    monkeypatch.setattr(weather_report, "_sleep", sleep)
    return Clock


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
        hour = weather_report._now().replace(minute=0, second=0, microsecond=0)
        form = parse_qs(request.content.decode())
        lats = [float(v) for v in form["latitude"][0].split(",")]
        lons = [float(v) for v in form["longitude"][0].split(",")]
        calls.append(list(zip(lats, lons, strict=True)))
        stamps = [(hour + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(96)]
        units = {
            "wind_speed_10m": "mp/h",
            "wind_gusts_10m": "mp/h",
            "precipitation": "inch",
            "snowfall": "inch",
        }
        bodies = [
            {
                "hourly_units": units,
                "hourly": {
                    "time": stamps,
                    "wind_speed_10m": [wind(lat, lon, i) for i in range(96)],
                    "wind_gusts_10m": [gust(lat, lon, i) for i in range(96)],
                    "precipitation": [precipitation(lat, lon, i) for i in range(96)],
                    "snowfall": [snowfall(lat, lon, i) for i in range(96)],
                },
            }
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


@pytest.mark.parametrize("no_travel_miles", [0.0, FLOAT_MARGIN / 2, FLOAT_MARGIN, 2 * FLOAT_MARGIN])
def test_the_one_route_rule_matches_rank_routes(no_travel_miles):
    def candidate(route_id, no_travel):
        summary = summarize_route(
            100.0,
            [Checkpoint(0, Level.LOW), Checkpoint(100 - no_travel, Level.NO_TRAVEL)],
        )
        return RouteCandidate(route_id, 3600, summary)

    mine = candidate("a", no_travel_miles)
    worse = candidate("b", 50.0)
    ranking = rank_routes([mine, worse], 25)
    single = weather_report.single_route_ranking(mine, 25)

    assert ranking.routes[0].route_id == "a"
    assert single["recommended_id"] == ranking.recommended_id
    assert single["routes"][0] == ranking.routes[0]


def test_the_one_route_rule_matches_rank_routes_without_a_forecast():
    summary = RouteSummary(0, 0, 0, 0, 0, 100.0, None)
    mine = RouteCandidate("a", 3600, summary)
    other = RouteCandidate("b", 7200, RouteSummary(0, 0, 0, 0, 100.0, 0, 4.0))

    ranking = rank_routes([mine, other], 25)
    single = weather_report.single_route_ranking(mine, 25)

    assert single["recommended_id"] == ranking.recommended_id
    assert single["routes"][0] == ranking.routes[0]


async def test_a_repeated_request_fetches_nothing(provider_mock):
    calls = forecast(provider_mock)
    body = request(route(), route("route-2", lon=-99.0))

    first = await post(body)
    fetched = len(calls)
    second = await post(body)

    assert fetched > 0 and len(calls) == fetched
    assert second.json() == first.json()


async def test_a_new_hour_fetches_again(provider_mock, monkeypatch):
    calls = forecast(provider_mock)
    await post(request(route()))
    fetched = len(calls)

    monkeypatch.setattr(weather_report, "_now", lambda: NOW + timedelta(hours=1))
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


async def test_a_chunk_that_fails_leaves_the_others_cached_for_the_retry(provider_mock):
    calls = forecast(provider_mock)
    body = long_trip()
    cells = planned_cells(body)
    failing = cell_center(cells[150])  # the first location of the second chunk

    def answer(request):
        first_latitude = parse_qs(request.content.decode())["latitude"][0].split(",")[0]
        if first_latitude == f"{failing[0]:.2f}":
            return httpx.Response(500)
        return calls.answer(request)

    calls.route.mock(side_effect=answer)

    failed = await post(body)

    assert failed.status_code == 502
    assert failed.json()["code"] == "provider_unavailable"
    cached = {cell for cell in cells if weather_report.CACHE.get(cell, HOUR)}
    assert cached and len(cached) < len(cells)
    calls.route.mock(side_effect=calls.answer)
    calls.clear()

    retried = await post(body)

    assert retried.status_code == 200
    assert sorted(locations(calls)) == sorted(cell_center(c) for c in cells if c not in cached)


async def test_a_short_refusal_is_waited_out_and_the_request_succeeds(provider_mock, fake_clock):
    calls = forecast(provider_mock)
    refusals = [httpx.Response(429, headers={"Retry-After": "30"})]
    calls.route.mock(side_effect=lambda r: refusals.pop() if refusals else calls.answer(r))

    response = await post(request(route()))

    assert response.status_code == 200
    assert fake_clock.sleeps == [31.0]


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
    provider_mock, fake_clock
):
    provider_mock.post(host="api.open-meteo.com").respond(429, headers={"Retry-After": "60"})

    response = await post(request(route()))

    # 150 s of budget: two waits of 61 s fit, a third (at 122 s) would end past the deadline.
    assert fake_clock.sleeps == [61.0, 61.0]
    assert response.status_code == 503
    assert response.json()["code"] == "provider_limited"


async def test_a_call_that_times_out_twice_is_a_504(provider_mock):
    route_ = provider_mock.post(host="api.open-meteo.com").mock(side_effect=httpx.ReadTimeout("x"))

    response = await post(request(route()))

    assert route_.call_count == 2
    assert response.status_code == 504
    assert response.json()["code"] == "provider_timeout"


async def test_a_passed_deadline_is_a_504_and_nothing_is_cached(provider_mock, monkeypatch):
    async def hang(request):
        await asyncio.sleep(30)

    provider_mock.post(host="api.open-meteo.com").mock(side_effect=hang)
    monkeypatch.setattr(weather_report, "BUDGET_S", 0.01)

    response = await post(request(route()))

    assert response.status_code == 504
    assert len(weather_report.CACHE) == 0


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
    provider_mock, monkeypatch
):
    calls = forecast(provider_mock)
    monkeypatch.setattr(weather_report, "MAX_LOCATIONS", 5)

    response = await post(request(route()))

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
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


MARK_CASES = {
    "valid": ([0, 5, 10], 10),
    "last mark at the end": ([0, 10], 10),
    "last mark just past the end": ([0, 10.000001], 10),
    "last mark far past the end": ([0, 20], 10),
    "first mark not 0": ([1, 10], 10),
    "first mark just above 0": ([1e-9, 10], 10),
    "equal marks": ([0, 5, 5], 10),
    "descending marks": ([0, 8, 5], 10),
    "a single mark": ([0], 10),
    "a single mark at 0 on a zero-mile route": ([0], 0),
}


@pytest.mark.parametrize(("marks", "total"), MARK_CASES.values(), ids=MARK_CASES.keys())
def test_the_schema_rejects_everything_summarize_route_rejects(marks, total):
    checkpoints = [Checkpoint(mark, Level.LOW) for mark in marks]
    try:
        summarize_route(total, checkpoints)
    except ValueError:
        rules_reject = True
    else:
        rules_reject = False
    body = request(route(marks=tuple(marks), total=total), spacing=50)
    try:
        WeatherIn.model_validate(body)
    except ValueError:
        schema_rejects = True
    else:
        schema_rejects = False

    assert schema_rejects or not rules_reject


@pytest.mark.parametrize("spacing", [10, 25, 50])
async def test_what_the_routes_endpoint_returns_is_accepted_as_it_is(
    provider_mock, monkeypatch, spacing
):
    # Two provider routes and a via-city route, sent back unchanged: lines, sources and all.
    monkeypatch.setattr(weather_report, "_now", lambda: datetime.now(UTC))
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
