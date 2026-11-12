import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from django.test import AsyncClient

from api import planner
from risk_rules import Checkpoint, Level, summarize_route
from routing import CITIES
from tests.route_fixtures import tomtom_body, tomtom_route

KEY = "test-tomtom-key"
LA, NY = CITIES["Los Angeles"], CITIES["New York"]
DENVER, SALT_LAKE, ALBUQUERQUE = CITIES["Denver"], CITIES["Salt Lake City"], CITIES["Albuquerque"]
CHICAGO = CITIES["Chicago"]

MAIN = [LA, DENVER, NY]
NORTH = [LA, SALT_LAKE, CHICAGO, NY]
SOUTH_ROUTE = [LA, ALBUQUERQUE, NY]
SLOW_COPY_OF_MAIN = [LA, (39.76, -105.0), NY]


def payload(**overrides) -> dict:
    body = {
        "origin": {"lat": LA[0], "lon": LA[1]},
        "destination": {"lat": NY[0], "lon": NY[1]},
        "departure": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
        "load_lb": 60_000,
        "checkpoint_interval_miles": 50,
    }
    return {**body, **overrides}


async def post(body: dict):
    return await AsyncClient().post(
        "/api/routes", data=json.dumps(body), content_type="application/json"
    )


def is_via_call(request: httpx.Request) -> bool:
    return request.url.path.count(":") == 2


def mock_tomtom(provider_mock, *, base, via=None):
    """Answer the base call with `base` routes and a via call with `via(request)`."""
    calls = []

    async def answer(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if is_via_call(request):
            return await via(request)
        return httpx.Response(200, json=tomtom_body(*[tomtom_route(w) for w in base]))

    provider_mock.get(host="api.tomtom.com").mock(side_effect=answer)
    return calls


def via_returns(waypoints_by_city: dict[str, list]):
    """Answer a via call with the route given for its city, or else one that copies MAIN."""

    async def answer(request: httpx.Request) -> httpx.Response:
        waypoints = SLOW_COPY_OF_MAIN
        for city, candidate in waypoints_by_city.items():
            lat, lon = CITIES[city]
            if f"{lat:.5f},{lon:.5f}" in request.url.path:
                waypoints = candidate
        return httpx.Response(200, json=tomtom_body(tomtom_route(waypoints, speed_mps=22)))

    return answer


def assert_no_key(response, caplog):
    assert KEY not in response.content.decode()
    assert KEY not in caplog.text


async def test_three_provider_routes_need_no_fill(provider_mock, caplog):
    caplog.set_level(logging.DEBUG)
    calls = mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])

    response = await post(payload())

    body = response.json()
    assert response.status_code == 200
    assert len(calls) == 1
    assert [r["id"] for r in body["routes"]] == ["route-1", "route-2", "route-3"]
    assert body["shortfall"] is None
    assert body["load_lb"] == 60_000 and body["checkpoint_interval_miles"] == 50
    assert all(r["source"] == "provider" and r["via"] is None for r in body["routes"])
    times = [r["travel_time_seconds"] for r in body["routes"]]
    assert times == sorted(times)
    assert_no_key(response, caplog)


async def test_each_route_carries_line_checkpoints_and_etas(provider_mock):
    mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])
    departure = (datetime.now(UTC) + timedelta(hours=2)).replace(microsecond=0)

    body = (await post(payload(departure=departure.isoformat()))).json()

    for route in body["routes"]:
        checkpoints = route["checkpoints"]
        assert checkpoints[0]["mile"] == 0
        assert datetime.fromisoformat(checkpoints[0]["eta"]) == departure
        assert checkpoints[-1]["mile"] == pytest.approx(route["total_miles"])
        arrival = datetime.fromisoformat(checkpoints[-1]["eta"])
        assert (arrival - departure).total_seconds() == pytest.approx(
            route["travel_time_seconds"], abs=2
        )
        assert len(route["line"]) >= 2
        lon, lat = route["line"][0]
        assert (lat, lon) == pytest.approx(LA, abs=1e-6)


async def test_checkpoints_are_accepted_by_the_risk_rules_summary(provider_mock):
    mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])

    for spacing in (10, 25, 50):
        body = (await post(payload(checkpoint_interval_miles=spacing))).json()
        for route in body["routes"]:
            summary = summarize_route(
                route["total_miles"],
                [Checkpoint(c["mile"], Level.LOW) for c in route["checkpoints"]],
            )
            assert summary.low_miles == pytest.approx(route["total_miles"])


async def test_the_weather_send_back_subset_excludes_the_line(provider_mock):
    mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])

    body = (await post(payload())).json()

    send_back = {"id", "travel_time_seconds", "total_miles", "checkpoints"}
    assert send_back < set(body["routes"][0])
    assert {"line", "source", "via"} <= set(body["routes"][0]) - send_back


# For base routes MAIN and NORTH the via candidates, in the order they are tried, are
# St. Louis, Albuquerque, Minneapolis, Louisville, Fargo and Amarillo; four start at once.
CANDIDATES = ["St. Louis", "Albuquerque", "Minneapolis", "Louisville", "Fargo", "Amarillo"]


async def test_two_provider_routes_are_filled_with_a_distinct_via_city_route(provider_mock):
    calls = mock_tomtom(
        provider_mock, base=[MAIN, NORTH], via=via_returns({"Albuquerque": SOUTH_ROUTE})
    )

    body = (await post(payload())).json()

    assert len(body["routes"]) == 3
    assert body["shortfall"] is None
    filled = [r for r in body["routes"] if r["source"] == "via_city"]
    assert len(filled) == 1
    assert filled[0]["via"]["name"] == "Albuquerque"
    via_calls = [c for c in calls if is_via_call(c)]
    assert all(c.url.params["maxAlternatives"] == "0" for c in via_calls)


async def test_once_the_gap_is_filled_no_further_candidate_is_tried(provider_mock):
    calls = mock_tomtom(
        provider_mock, base=[MAIN, NORTH], via=via_returns({"Albuquerque": SOUTH_ROUTE})
    )

    await post(payload())

    assert len([c for c in calls if is_via_call(c)]) == 4


async def test_a_later_candidate_is_tried_when_earlier_ones_overlap(provider_mock):
    calls = mock_tomtom(
        provider_mock, base=[MAIN, NORTH], via=via_returns({"Amarillo": SOUTH_ROUTE})
    )

    body = (await post(payload())).json()

    assert body["shortfall"] is None
    assert [r["via"]["name"] for r in body["routes"] if r["via"]] == ["Amarillo"]
    assert len([c for c in calls if is_via_call(c)]) == 6


async def test_a_fill_that_overlaps_an_existing_route_is_dropped_with_the_reason(provider_mock):
    calls = mock_tomtom(provider_mock, base=[MAIN, NORTH], via=via_returns({}))

    response = await post(payload())

    body = response.json()
    assert response.status_code == 200
    assert len(body["routes"]) == 2
    assert body["shortfall"]["reason"] == "no_distinct_alternative"
    assert "2 routes" in body["shortfall"]["message"]
    for city in CANDIDATES:
        assert city in body["shortfall"]["message"]
    assert len([c for c in calls if is_via_call(c)]) == 6


async def test_one_provider_route_and_unroutable_via_cities_return_the_one_route(provider_mock):
    async def no_route(request):
        return httpx.Response(400, json={"detailedError": {"code": "MAP_MATCHING_FAILURE"}})

    mock_tomtom(provider_mock, base=[MAIN], via=no_route)

    body = (await post(payload())).json()

    assert len(body["routes"]) == 1
    assert body["routes"][0]["id"] == "route-1"
    assert body["shortfall"]["reason"] == "no_distinct_alternative"
    assert "Only 1 route " in body["shortfall"]["message"]
    assert "were tried" in body["shortfall"]["message"]


async def test_a_failed_fill_is_not_a_failed_request(provider_mock, caplog):
    caplog.set_level(logging.DEBUG)

    async def broken(request):
        return httpx.Response(500, text=f"upstream says {KEY}")

    mock_tomtom(provider_mock, base=[MAIN, NORTH], via=broken)

    response = await post(payload())

    body = response.json()
    assert response.status_code == 200
    assert len(body["routes"]) == 2
    assert body["shortfall"]["reason"] == "fill_incomplete"
    assert_no_key(response, caplog)


async def test_when_the_budget_runs_out_during_the_fill_the_routes_in_hand_come_back(
    provider_mock, monkeypatch
):
    monkeypatch.setattr(planner, "PLANNING_BUDGET_S", 0.3)
    cancelled = 0

    async def never(request):
        nonlocal cancelled
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled += 1
            raise

    mock_tomtom(provider_mock, base=[MAIN, NORTH], via=never)

    response = await post(payload())

    assert response.status_code == 200
    assert response.json()["shortfall"]["reason"] == "fill_incomplete"
    assert len(response.json()["routes"]) == 2
    assert cancelled == 4


async def test_candidates_run_concurrently_up_to_the_cap(provider_mock):
    in_flight = peak = started = 0
    release = asyncio.Event()

    async def gated(request):
        nonlocal in_flight, peak, started
        started += 1
        in_flight += 1
        peak = max(peak, in_flight)
        if started == 4:
            release.set()
        await asyncio.wait_for(release.wait(), timeout=5)
        in_flight -= 1
        return httpx.Response(200, json=tomtom_body(tomtom_route(SLOW_COPY_OF_MAIN)))

    mock_tomtom(provider_mock, base=[MAIN, NORTH], via=gated)

    response = await post(payload())

    assert response.status_code == 200
    assert peak == 4
    assert started == 6


async def test_a_base_call_that_exceeds_the_budget_is_a_gateway_timeout(provider_mock, monkeypatch):
    monkeypatch.setattr(planner, "PLANNING_BUDGET_S", 0.1)

    async def slow(request):
        await asyncio.sleep(5)

    provider_mock.get(host="api.tomtom.com").mock(side_effect=slow)

    response = await post(payload())

    assert response.status_code == 504
    assert response.json()["code"] == "provider_timeout"


@pytest.mark.parametrize(
    ("upstream", "status", "code"),
    [
        (httpx.Response(200, json={"routes": []}), 422, "no_route"),
        (
            httpx.Response(400, json={"detailedError": {"code": "MAP_MATCHING_FAILURE"}}),
            422,
            "no_route",
        ),
        (httpx.Response(500), 502, "provider_unavailable"),
        (httpx.Response(200, text="oops"), 502, "provider_malformed_response"),
        (
            httpx.Response(200, json={"routes": [{"summary": {}}]}),
            502,
            "provider_malformed_response",
        ),
        (httpx.Response(429, text=KEY), 503, "provider_limited"),
        (httpx.Response(403), 503, "provider_limited"),
        (httpx.ReadTimeout("slow"), 504, "provider_timeout"),
        (httpx.ConnectError(f"cannot reach host with {KEY}"), 502, "provider_unavailable"),
    ],
)
async def test_provider_failures_surface_as_api_errors_without_the_key(
    provider_mock, caplog, upstream, status, code
):
    caplog.set_level(logging.DEBUG)
    route = provider_mock.get(host="api.tomtom.com")
    if isinstance(upstream, Exception):
        route.mock(side_effect=upstream)
    else:
        route.mock(return_value=upstream)

    response = await post(payload())

    assert response.status_code == status
    assert set(response.json()) == {"code", "message"}
    assert response.json()["code"] == code
    assert_no_key(response, caplog)


async def test_a_missing_key_is_a_clear_error_not_a_crash(settings):
    settings.TOMTOM_API_KEY = ""

    response = await post(payload())

    assert response.status_code == 503
    assert response.json()["code"] == "provider_not_configured"


@pytest.mark.parametrize(
    "overrides",
    [
        {"load_lb": 0},
        {"load_lb": -5},
        {"load_lb": 80_001},
        {"load_lb": "heavy"},
        {"checkpoint_interval_miles": 30},
        {"origin": {"lat": 91, "lon": 0}},
        {"destination": {"lat": 0, "lon": -181}},
        {"destination": {"lat": LA[0], "lon": LA[1]}},
        {"departure": "2026-11-13T08:00:00"},
        {"departure": "yesterday"},
        {"departure": (datetime.now(UTC) - timedelta(hours=1)).isoformat()},
        {"departure": (datetime.now(UTC) + timedelta(hours=49)).isoformat()},
    ],
)
async def test_invalid_requests_are_rejected_before_any_provider_call(provider_mock, overrides):
    response = await post(payload(**overrides))

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert response.json()["message"]
    assert provider_mock.calls.call_count == 0


async def test_a_missing_field_is_a_validation_error():
    body = payload()
    del body["departure"]

    response = await post(body)

    assert response.status_code == 422
    assert "departure" in response.json()["message"]


async def test_the_limits_themselves_are_accepted(provider_mock):
    mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])
    just_past = (datetime.now(UTC) - timedelta(minutes=10)).isoformat()

    assert (await post(payload(load_lb=80_000, departure=just_past))).status_code == 200
    assert (await post(payload(load_lb=0.5, checkpoint_interval_miles=10))).status_code == 200


async def test_the_openapi_schema_declares_the_error_body():
    response = await AsyncClient().get("/api/openapi.json")

    responses = response.json()["paths"]["/api/routes"]["post"]["responses"]
    assert {"200", "422", "502", "503", "504"} <= set(responses)
    assert "ErrorOut" in json.dumps(responses["504"])


async def test_a_short_trip_with_no_city_to_route_through_says_so(provider_mock):
    chicago, indianapolis = CITIES["Chicago"], CITIES["Indianapolis"]
    calls = mock_tomtom(provider_mock, base=[[chicago, indianapolis], [chicago, indianapolis]])

    response = await post(
        payload(
            origin={"lat": chicago[0], "lon": chicago[1]},
            destination={"lat": indianapolis[0], "lon": indianapolis[1]},
        )
    )

    body = response.json()
    assert body["shortfall"]["reason"] == "no_distinct_alternative"
    assert "no large city" in body["shortfall"]["message"]
    assert len(calls) == 1
