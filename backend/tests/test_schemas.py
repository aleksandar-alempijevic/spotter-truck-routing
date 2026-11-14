"""The shared plan and route types own the bounds, so the weather request inherits them."""

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from api.schemas import (
    MAX_CHECKPOINTS_PER_ROUTE,
    CheckpointOut,
    PlanParams,
    RouteCore,
    RoutesIn,
)

ETA = datetime(2026, 11, 13, 8, 0, tzinfo=UTC)


def checkpoint(**overrides) -> dict:
    return {"mile": 0.0, "lat": 40.0, "lon": -100.0, "eta": ETA, **overrides}


def route(**overrides) -> dict:
    return {
        "id": "route-1",
        "travel_time_seconds": 3600,
        "total_miles": 50.0,
        "checkpoints": [checkpoint()],
        **overrides,
    }


def test_a_valid_send_back_route_is_accepted():
    assert RouteCore.model_validate(route()).id == "route-1"


@pytest.mark.parametrize(
    "load",
    [
        pytest.param(0, id="zero"),
        pytest.param(-1, id="negative"),
        pytest.param(47_001, id="over the limit"),
        pytest.param(float("nan"), id="NaN"),
        pytest.param(float("inf"), id="infinite"),
    ],
)
def test_the_load_bounds_hold_on_the_shared_plan_parameters(load):
    with pytest.raises(ValidationError):
        PlanParams(load_lb=load, checkpoint_interval_miles=25)


def test_the_load_limit_itself_is_accepted():
    assert PlanParams(load_lb=47_000, checkpoint_interval_miles=25).load_lb == 47_000


def test_the_routes_request_reuses_the_shared_definitions_of_its_two_fields():
    for name, shared in PlanParams.model_fields.items():
        assert RoutesIn.model_fields[name].annotation == shared.annotation
        assert RoutesIn.model_fields[name].metadata == shared.metadata


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param({"eta": datetime(2026, 11, 13, 8, 0)}, id="naive eta"),
        pytest.param({"lat": 91}, id="latitude out of range"),
        pytest.param({"lon": -181}, id="longitude out of range"),
        pytest.param({"lat": float("nan")}, id="NaN latitude"),
        pytest.param({"mile": -1}, id="negative mile"),
        pytest.param({"mile": float("inf")}, id="infinite mile"),
    ],
)
def test_checkpoint_bounds(bad):
    with pytest.raises(ValidationError):
        CheckpointOut(**checkpoint(**bad))


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param({"id": ""}, id="empty id"),
        pytest.param({"id": "x" * 65}, id="long id"),
        pytest.param({"travel_time_seconds": -1}, id="negative travel time"),
        pytest.param({"total_miles": -1}, id="negative miles"),
        pytest.param({"checkpoints": []}, id="no checkpoints"),
        pytest.param(
            {"checkpoints": [checkpoint()] * (MAX_CHECKPOINTS_PER_ROUTE + 1)}, id="too many"
        ),
    ],
)
def test_route_bounds(bad):
    with pytest.raises(ValidationError):
        RouteCore(**route(**bad))


def test_the_checkpoint_cap_is_accepted_and_covers_the_longest_test_route():
    full = RouteCore(**route(checkpoints=[checkpoint()] * MAX_CHECKPOINTS_PER_ROUTE))

    assert len(full.checkpoints) == MAX_CHECKPOINTS_PER_ROUTE
    assert MAX_CHECKPOINTS_PER_ROUTE >= 357  # Seattle to Miami, 3,558 miles, at 10-mile spacing
