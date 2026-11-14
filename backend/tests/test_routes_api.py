import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta, timezone

import httpx
import pytest
from django.test import AsyncClient

from api import planner
from api.schemas import PlanParams, RouteCore
from routing.via_cities import CITIES
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


async def test_the_request_reaches_tomtom_and_the_checkpoints_as_given(provider_mock):
    calls = mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])
    # A departure in a zone other than UTC, so the offset has to survive to both consumers.
    departure = (datetime.now(timezone(timedelta(hours=-6))) + timedelta(hours=3)).replace(
        microsecond=0
    )

    ten = (
        await post(payload(departure=departure.isoformat(), checkpoint_interval_miles=10))
    ).json()
    fifty = (
        await post(payload(departure=departure.isoformat(), checkpoint_interval_miles=50))
    ).json()

    request = calls[0]
    assert request.url.params["vehicleWeight"] == "42184"  # 60,000 lb + 33,000 lb rig
    assert request.url.params["departAt"] == departure.isoformat()
    assert request.url.path.split("/")[-2] == (
        f"{LA[0]:.5f},{LA[1]:.5f}:{NY[0]:.5f},{NY[1]:.5f}"  # origin first, then destination
    )
    for body in (ten, fifty):
        assert datetime.fromisoformat(body["routes"][0]["checkpoints"][0]["eta"]) == departure
    marks_10 = [c["mile"] for c in ten["routes"][0]["checkpoints"]]
    marks_50 = [c["mile"] for c in fifty["routes"][0]["checkpoints"]]
    assert marks_10[:3] == [0, 10, 20]
    assert marks_50[:3] == [0, 50, 100]
    assert len(marks_10) > 4 * len(marks_50) - 5


async def test_the_response_has_exactly_the_documented_fields(provider_mock):
    mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])

    body = (await post(payload())).json()

    send_back = {"id", "travel_time_seconds", "total_miles", "checkpoints", "stops"}
    assert set(body) == {
        "load_lb",
        "checkpoint_interval_miles",
        "routes",
        "shortfall",
        "breaks_applied",
    }
    assert set(RouteCore.model_fields) == send_back
    assert set(PlanParams.model_fields) == {"load_lb", "checkpoint_interval_miles"}
    for route in body["routes"]:
        assert set(route) == send_back | {"line", "source", "via", "driving_seconds"}
        assert set(route["checkpoints"][0]) == {"mile", "lat", "lon", "eta"}


async def test_the_send_back_subset_is_the_response_without_the_line_source_and_via(
    provider_mock,
):
    mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])
    body = (await post(payload())).json()

    send_back = {
        **{name: body[name] for name in PlanParams.model_fields},
        "routes": [{name: r[name] for name in RouteCore.model_fields} for r in body["routes"]],
    }

    class SendBack(PlanParams):
        routes: list[RouteCore]

    assert SendBack.model_validate(send_back).routes[0].id == "route-1"


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


async def test_once_the_gap_is_filled_the_calls_still_pending_are_cancelled(provider_mock):
    started = cancelled = 0
    south = via_returns({"Albuquerque": SOUTH_ROUTE})

    async def answer(request):
        nonlocal started, cancelled
        started += 1
        if f"{ALBUQUERQUE[0]:.5f}" in request.url.path:
            return await south(request)
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled += 1
            raise

    mock_tomtom(provider_mock, base=[MAIN, NORTH], via=answer)

    body = (await post(payload())).json()

    assert body["shortfall"] is None
    # Four calls start at once (the cap). Albuquerque's answer frees a slot for a fifth, and the
    # sixth never starts: it is cancelled while it waits.
    assert started == 5
    assert cancelled == 4


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


async def test_no_route_between_the_points_is_a_422(provider_mock):
    provider_mock.get(host="api.tomtom.com").respond(
        400, json={"detailedError": {"code": "MAP_MATCHING_FAILURE"}}
    )

    response = await post(payload())

    assert response.status_code == 422
    assert response.json()["code"] == "no_route"


async def test_a_trip_only_reachable_through_canada_is_a_422_no_route(provider_mock):
    provider_mock.get(host="api.tomtom.com").respond(
        json=tomtom_body(tomtom_route(MAIN, countries=("USA", "CAN", "USA")))
    )

    response = await post(payload())

    assert response.status_code == 422
    assert response.json()["code"] == "no_route"
    assert "United States" in response.json()["message"]


async def test_every_call_avoids_border_crossings_and_a_via_route_through_canada_is_not_kept(
    provider_mock,
):
    async def through_canada(request):
        return httpx.Response(
            200, json=tomtom_body(tomtom_route(NORTH, speed_mps=22, countries=("USA", "CAN")))
        )

    calls = mock_tomtom(provider_mock, base=[MAIN, SOUTH_ROUTE], via=through_canada)

    body = (await post(payload())).json()

    assert len(calls) > 1
    assert {c.url.params["avoid"] for c in calls} == {"borderCrossings"}
    assert {r["source"] for r in body["routes"]} == {"provider"}


async def test_a_missing_key_is_a_clear_error_not_a_crash(settings):
    settings.TOMTOM_API_KEY = ""

    response = await post(payload())

    assert response.status_code == 503
    assert response.json()["code"] == "provider_not_configured"


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"load_lb": 0}, id="zero load"),
        pytest.param({"load_lb": -5}, id="negative load"),
        pytest.param({"load_lb": 80_001}, id="load over the limit"),
        pytest.param({"load_lb": "heavy"}, id="load not a number"),
        pytest.param({"checkpoint_interval_miles": 30}, id="interval not offered"),
        pytest.param({"origin": {"lat": 91, "lon": 0}}, id="latitude out of range"),
        pytest.param({"destination": {"lat": 0, "lon": -181}}, id="longitude out of range"),
        pytest.param({"destination": {"lat": LA[0], "lon": LA[1]}}, id="same point"),
        pytest.param({"departure": "2026-11-13T08:00:00"}, id="naive departure"),
        pytest.param({"departure": "yesterday"}, id="departure not a time"),
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


async def test_the_largest_load_and_the_smallest_whole_kilogram_are_accepted(provider_mock):
    calls = mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])

    assert (await post(payload(load_lb=80_000))).status_code == 200
    assert (await post(payload(load_lb=2.2046))).status_code == 200  # the smallest whole kilogram

    assert [c.url.params["vehicleWeight"] for c in calls] == ["51256", "14970"]


async def test_the_smallest_checkpoint_interval_is_accepted(provider_mock):
    mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])

    assert (await post(payload(checkpoint_interval_miles=10))).status_code == 200


@pytest.mark.parametrize(
    ("offset", "accepted"),
    [
        pytest.param(timedelta(minutes=-14), True, id="14 minutes ago"),
        pytest.param(timedelta(minutes=-16), False, id="16 minutes ago"),
        pytest.param(timedelta(hours=47, minutes=59), True, id="47h59m ahead"),
        pytest.param(timedelta(hours=48, minutes=1), False, id="48h01m ahead"),
    ],
)
async def test_the_departure_window_is_checked_at_both_ends(provider_mock, offset, accepted):
    mock_tomtom(provider_mock, base=[MAIN, NORTH, SOUTH_ROUTE])

    response = await post(payload(departure=(datetime.now(UTC) + offset).isoformat()))

    assert response.status_code == (200 if accepted else 422)


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
