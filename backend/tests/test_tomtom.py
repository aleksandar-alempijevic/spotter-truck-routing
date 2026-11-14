import logging
from datetime import UTC, datetime

import httpx
import pytest

from providers import Outbound, calculate_routes
from providers.errors import (
    MalformedResponse,
    NoRouteFound,
    ProviderNotConfigured,
    ProviderUnavailable,
)
from providers.tomtom import gross_weight_kilograms, pounds_to_kilograms
from routing import Via
from tests.route_fixtures import tomtom_body, tomtom_route

KEY = "test-tomtom-key"
ORIGIN, DESTINATION = (41.0, -100.0), (41.0, -85.0)
DEPARTURE = datetime(2026, 11, 13, 8, 0, tzinfo=UTC)


async def call(**overrides):
    args = {
        "origin": ORIGIN,
        "destination": DESTINATION,
        "departure": DEPARTURE,
        "load_lb": 80_000,
        "alternatives": 2,
    }
    async with Outbound() as outbound:
        return await calculate_routes(outbound, KEY, **{**args, **overrides})


def test_pounds_convert_to_kilograms():
    assert pounds_to_kilograms(80_000) == 36_287
    assert pounds_to_kilograms(2.2046) == 1


def test_gross_weight_adds_the_empty_rig_to_the_cargo():
    assert gross_weight_kilograms(0) == 14_969
    assert gross_weight_kilograms(80_000) == 51_256


async def test_request_carries_kilograms_truck_mode_and_coded_instructions(provider_mock):
    route = provider_mock.get(host="api.tomtom.com").respond(
        json=tomtom_body(tomtom_route([ORIGIN, DESTINATION]))
    )

    await call()

    request = route.calls.last.request
    params = request.url.params
    assert request.url.path.endswith("/41.00000,-100.00000:41.00000,-85.00000/json")
    assert params["vehicleWeight"] == "51256"  # 80,000 lb + 33,000 lb rig
    assert params["travelMode"] == "truck"
    assert params["avoid"] == "borderCrossings"
    assert params["sectionType"] == "country"
    assert params["instructionsType"] == "coded"
    assert params["maxAlternatives"] == "2"
    assert params["departAt"] == "2026-11-13T08:00:00+00:00"
    assert params["key"] == KEY
    assert request.extensions["timeout"]["read"] == 50  # long trips take up to 30 s


async def test_a_via_point_goes_between_origin_and_destination_and_tags_the_route(provider_mock):
    via = Via("Chicago", 41.8781, -87.6298)
    route = provider_mock.get(host="api.tomtom.com").respond(
        json=tomtom_body(tomtom_route([ORIGIN, (41.8781, -87.6298), DESTINATION]))
    )

    routes = await call(via=via, alternatives=0)

    assert "41.87810,-87.62980" in route.calls.last.request.url.path
    assert route.calls.last.request.url.params["maxAlternatives"] == "0"
    assert routes[0].via == via
    assert routes[0].source == "via_city"


async def test_routes_are_parsed_across_legs_with_cumulative_knots(provider_mock):
    provider_mock.get(host="api.tomtom.com").respond(
        json=tomtom_body(
            tomtom_route([ORIGIN, (41.8781, -87.6298), DESTINATION]),
            tomtom_route([ORIGIN, (45.0, -92.0), DESTINATION]),
        )
    )

    routes = await call()

    assert len(routes) == 2
    assert routes[0].source == "provider"
    assert routes[0].knots[0] == (0.0, 0.0)
    assert routes[0].knots[-1][1] == routes[0].travel_time_s
    assert routes[0].points[0] == ORIGIN and routes[0].points[-1] == DESTINATION


async def test_a_missing_key_is_an_error_at_call_time():
    async with Outbound() as outbound:
        with pytest.raises(ProviderNotConfigured):
            await calculate_routes(
                outbound,
                "",
                origin=ORIGIN,
                destination=DESTINATION,
                departure=DEPARTURE,
                load_lb=1000,
                alternatives=0,
            )


@pytest.mark.parametrize(
    ("response", "error"),
    [
        pytest.param(httpx.Response(200, json={"routes": []}), NoRouteFound, id="no routes"),
        pytest.param(
            httpx.Response(400, json={"detailedError": {"code": "MAP_MATCHING_FAILURE"}}),
            NoRouteFound,
            id="map matching failure",
        ),
        pytest.param(
            httpx.Response(400, json={"detailedError": {"code": "NO_ROUTE_FOUND"}}),
            NoRouteFound,
            id="no route found",
        ),
        pytest.param(
            httpx.Response(400, json={"detailedError": {"code": "BAD_INPUT"}}),
            ProviderUnavailable,
            id="other 400 code",
        ),
        pytest.param(httpx.Response(400, text="not json"), ProviderUnavailable, id="400 not JSON"),
        pytest.param(
            httpx.Response(200, json={"nothing": 1}), MalformedResponse, id="no routes key"
        ),
        pytest.param(
            httpx.Response(200, json={"routes": [{"summary": {}}]}),
            MalformedResponse,
            id="route without fields",
        ),
        pytest.param(
            httpx.Response(200, json={"routes": "none"}), MalformedResponse, id="routes not a list"
        ),
    ],
)
async def test_tomtoms_own_failures_become_neutral_errors(provider_mock, response, error):
    provider_mock.get(host="api.tomtom.com").mock(return_value=response)

    with pytest.raises(error):
        await call()


async def test_a_route_with_time_knots_that_go_backwards_is_malformed(provider_mock):
    bad = tomtom_route([ORIGIN, DESTINATION])
    bad["guidance"]["instructions"][2]["travelTimeInSeconds"] = 1
    provider_mock.get(host="api.tomtom.com").respond(json=tomtom_body(bad))

    with pytest.raises(MalformedResponse):
        await call()


async def test_a_second_leg_that_restarts_its_offsets_is_malformed(provider_mock):
    # Instruction offsets that restart at each leg would break the knot rule; fail, don't guess.
    bad = tomtom_route([ORIGIN, (41.5, -92.0), DESTINATION])
    instructions = bad["guidance"]["instructions"]
    half = len(instructions) // 2
    for instruction in instructions[half:]:
        instruction["routeOffsetInMeters"] -= instructions[half]["routeOffsetInMeters"]
        instruction["travelTimeInSeconds"] -= instructions[half]["travelTimeInSeconds"]
    provider_mock.get(host="api.tomtom.com").respond(json=tomtom_body(bad))

    with pytest.raises(MalformedResponse):
        await call()


@pytest.mark.parametrize(
    ("response", "outcome"),
    [
        pytest.param(
            httpx.Response(200, json=tomtom_body(tomtom_route([ORIGIN, DESTINATION]))),
            None,
            id="success",
        ),
        pytest.param(
            httpx.Response(500, text="the key is test-tomtom-key"), ProviderUnavailable, id="500"
        ),
        pytest.param(
            httpx.Response(400, json={"detailedError": {"code": "X", "message": KEY}}),
            ProviderUnavailable,
            id="400",
        ),
    ],
)
async def test_the_key_appears_in_no_log_record_at_debug_level(
    provider_mock, caplog, response, outcome
):
    provider_mock.get(host="api.tomtom.com").mock(return_value=response)
    caplog.set_level(logging.DEBUG)

    if outcome is None:
        assert len(await call()) == 1
    else:
        with pytest.raises(outcome):
            await call()

    assert KEY not in caplog.text
    assert all(KEY not in record.getMessage() for record in caplog.records)


async def test_a_route_through_canada_is_dropped_and_the_others_kept(provider_mock):
    provider_mock.get(host="api.tomtom.com").respond(
        json=tomtom_body(
            tomtom_route([ORIGIN, (45.0, -92.0), DESTINATION], countries=("USA", "CAN", "USA")),
            tomtom_route([ORIGIN, DESTINATION], countries=("USA",)),
        )
    )

    routes = await call()

    assert len(routes) == 1
    assert (45.0, -92.0) not in routes[0].points


async def test_only_routes_through_canada_is_no_route(provider_mock):
    provider_mock.get(host="api.tomtom.com").respond(
        json=tomtom_body(tomtom_route([ORIGIN, DESTINATION], countries=("USA", "CAN")))
    )

    with pytest.raises(NoRouteFound):
        await call()


def _without_sections(route: dict) -> dict:
    return {k: v for k, v in route.items() if k != "sections"}


@pytest.mark.parametrize(
    "route",
    [
        pytest.param(_without_sections(tomtom_route([ORIGIN, DESTINATION])), id="no sections"),
        pytest.param(
            {**tomtom_route([ORIGIN, DESTINATION]), "sections": [{"startPointIndex": 0}]},
            id="section without a country code",
        ),
    ],
)
async def test_a_route_that_does_not_name_its_countries_is_not_kept(provider_mock, route):
    provider_mock.get(host="api.tomtom.com").respond(json=tomtom_body(route))

    with pytest.raises(NoRouteFound):
        await call()
