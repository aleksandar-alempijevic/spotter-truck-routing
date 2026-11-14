"""The routes endpoint with the rest-break switch off and on, against mocked TomTom answers."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from tests.route_fixtures import tomtom_body, tomtom_route
from tests.test_routes_api import MAIN, NORTH, SOUTH_ROUTE, payload, post

# Three routes of about 430 km at 25 m/s: under 8 hours at the wheel.
SHORT = [
    [(41.0, -100.0), (41.0, -95.0)],
    [(41.0, -100.0), (41.6, -97.5), (41.0, -95.0)],
    [(41.0, -100.0), (40.4, -97.5), (41.0, -95.0)],
]
LONG = [MAIN, NORTH, SOUTH_ROUTE]  # Los Angeles to New York: about 45 hours at 25 m/s
CYCLE = LONG  # the same trip at 10 m/s: about 110 hours at the wheel, past the cycle limit
FIXTURES = {
    "short, under 8 hours": (SHORT, 25.0),
    "long, several shifts": (LONG, 25.0),
    "very long, past the 60-hour cycle": (CYCLE, 10.0),
}


def mock_routes(provider_mock, waypoints: list, speed_mps: float):
    async def answer(request: httpx.Request) -> httpx.Response:
        routes = [tomtom_route(w, speed_mps=speed_mps) for w in waypoints]
        return httpx.Response(200, json=tomtom_body(*routes))

    provider_mock.get(host="api.tomtom.com").mock(side_effect=answer)


FIXED_DEPARTURE = (datetime.now(UTC) + timedelta(hours=2)).replace(microsecond=0).isoformat()


def body_for(**overrides) -> dict:
    """A routes request with one departure for the whole test run, so two requests compare."""
    return payload(departure=FIXED_DEPARTURE, **overrides)


async def both_modes(provider_mock, waypoints, speed_mps, **overrides):
    mock_routes(provider_mock, waypoints, speed_mps)
    off = (await post(body_for(rest_breaks=False, **overrides))).json()
    on = (await post(body_for(rest_breaks=True, **overrides))).json()
    return off, on


def eta(checkpoint: dict) -> datetime:
    return datetime.fromisoformat(checkpoint["eta"])


async def test_a_request_without_the_field_is_the_same_as_false(provider_mock):
    mock_routes(provider_mock, LONG, 25.0)
    omitted = body_for()
    explicit = body_for(rest_breaks=False)
    assert "rest_breaks" not in omitted

    first = await post(omitted)
    second = await post(explicit)

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["breaks_applied"] is False


async def test_with_the_switch_off_every_route_has_no_stops_and_driving_time_is_travel_time(
    provider_mock,
):
    mock_routes(provider_mock, LONG, 25.0)

    body = (await post(body_for())).json()

    for route in body["routes"]:
        assert route["stops"] == []
        assert route["driving_seconds"] == route["travel_time_seconds"]
        arrival = eta(route["checkpoints"][-1]) - eta(route["checkpoints"][0])
        assert arrival.total_seconds() == pytest.approx(route["driving_seconds"], abs=2)


async def test_the_two_modes_differ_only_in_etas_travel_time_stops_and_the_echo(provider_mock):
    off, on = await both_modes(provider_mock, LONG, 25.0)

    assert (off["breaks_applied"], on["breaks_applied"]) == (False, True)
    assert {k: v for k, v in off.items() if k not in ("routes", "breaks_applied")} == {
        k: v for k, v in on.items() if k not in ("routes", "breaks_applied")
    }
    assert [r["id"] for r in off["routes"]] == [r["id"] for r in on["routes"]]
    for plain, broken in zip(off["routes"], on["routes"], strict=True):
        for field in ("id", "total_miles", "line", "source", "via", "driving_seconds"):
            assert plain[field] == broken[field]
        marks = [(c["mile"], c["lat"], c["lon"]) for c in plain["checkpoints"]]
        assert marks == [(c["mile"], c["lat"], c["lon"]) for c in broken["checkpoints"]]
        assert broken["stops"]
        assert broken["travel_time_seconds"] > plain["travel_time_seconds"]
        assert eta(broken["checkpoints"][-1]) > eta(plain["checkpoints"][-1])


async def test_a_trip_under_8_hours_is_identical_in_both_modes_apart_from_the_echo(provider_mock):
    off, on = await both_modes(provider_mock, SHORT, 25.0)

    assert off["routes"] == on["routes"]
    assert off["routes"][0]["driving_seconds"] < 8 * 3600
    assert off["routes"][0]["stops"] == []
    assert (off["breaks_applied"], on["breaks_applied"]) == (False, True)
    assert {k: v for k, v in off.items() if k != "breaks_applied"} == {
        k: v for k, v in on.items() if k != "breaks_applied"
    }


@pytest.mark.parametrize("mode", [False, True], ids=["off", "on"])
@pytest.mark.parametrize("name", list(FIXTURES))
async def test_the_duration_invariants_hold_for_every_routes_fixture(provider_mock, name, mode):
    waypoints, speed = FIXTURES[name]
    mock_routes(provider_mock, waypoints, speed)

    body = (await post(body_for(rest_breaks=mode, checkpoint_interval_miles=10))).json()

    assert body["breaks_applied"] is mode
    for route in body["routes"]:
        checkpoints, stops = route["checkpoints"], route["stops"]
        stopped = sum(stop["duration_seconds"] for stop in stops)
        # Last ETA minus first is the door-to-door time on the wire.
        arrival = eta(checkpoints[-1]) - eta(checkpoints[0])
        assert arrival.total_seconds() == pytest.approx(route["travel_time_seconds"], abs=2)
        # Door to door is driving time plus the stops.
        assert route["travel_time_seconds"] - route["driving_seconds"] == pytest.approx(
            stopped, abs=1
        )
        assert bool(stops) is (mode and route["driving_seconds"] > 8 * 3600)
        etas = [eta(c) for c in checkpoints]
        assert etas == sorted(etas)
        for stop in stops:
            starts = datetime.fromisoformat(stop["starts_at"])
            ends = starts + timedelta(seconds=stop["duration_seconds"])
            before = [c for c in checkpoints if eta(c) <= starts][-1]
            after = next(c for c in checkpoints if eta(c) >= ends)
            assert before["mile"] <= stop["mile"] + 1e-6 <= after["mile"] + 2e-6
            assert 0 < stop["mile"] < route["total_miles"]
        starts = [datetime.fromisoformat(s["starts_at"]) for s in stops]
        assert starts == sorted(starts)


async def test_the_long_trips_stops_are_the_regulations_kinds_in_order(provider_mock):
    mock_routes(provider_mock, CYCLE, 10.0)

    body = (await post(body_for(rest_breaks=True))).json()

    kinds = [s["kind"] for s in body["routes"][0]["stops"]]
    assert kinds[:4] == ["break", "rest", "break", "rest"]
    assert kinds.count("restart") == 1
    assert set(kinds) == {"break", "rest", "restart"}


async def test_the_order_by_driving_time_is_the_order_by_door_to_door_time(provider_mock):
    # The ranking's travel-time step is fed door-to-door time. Routes keep their order because
    # every route is timed by the same schedule, so less driving is always an earlier arrival.
    off, on = await both_modes(provider_mock, LONG, 25.0)

    for body in (off, on):
        driving = [r["driving_seconds"] for r in body["routes"]]
        door = [r["travel_time_seconds"] for r in body["routes"]]
        assert driving == sorted(driving)
        assert door == sorted(door)
        assert len(set(door)) == len(door)


async def test_a_non_boolean_switch_is_a_validation_error(provider_mock):
    response = await post(body_for(rest_breaks="sometimes"))

    assert response.status_code == 422
