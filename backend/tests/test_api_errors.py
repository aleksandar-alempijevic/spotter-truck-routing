"""Every response under /api/ is `{code, message}`, including those no endpoint produces."""

import json
import typing
from datetime import UTC, datetime, timedelta

import pytest
from django.test import AsyncClient

from api import api as api_module
from api.schemas import ErrorCode

CLIENT_ARGS = {"raise_request_exception": False}
DECLARED = set(typing.get_args(ErrorCode))


async def assert_error(response, status: int, code: str):
    assert response.status_code == status
    assert response["Content-Type"].startswith("application/json")
    body = response.json()
    assert body.keys() == {"code", "message"}
    assert body["code"] == code
    assert body["code"] in DECLARED
    assert body["message"]


async def test_a_body_that_is_not_json_is_a_validation_error():
    response = await AsyncClient(**CLIENT_ARGS).post(
        "/api/routes", data="{not json", content_type="application/json"
    )

    await assert_error(response, 422, "validation_error")


async def test_a_body_with_the_wrong_content_type_is_a_validation_error():
    response = await AsyncClient(**CLIENT_ARGS).post(
        "/api/routes", data="origin=1", content_type="text/plain"
    )

    await assert_error(response, 422, "validation_error")


@pytest.mark.parametrize(
    ("method", "path"),
    [
        pytest.param("get", "/api/routes", id="GET on the routes endpoint"),
        pytest.param("post", "/api/health", id="POST on health"),
        pytest.param("post", "/api/address-search", id="POST on address search"),
    ],
)
async def test_a_wrong_method_is_a_405(method, path):
    response = await getattr(AsyncClient(**CLIENT_ARGS), method)(path)

    await assert_error(response, 405, "method_not_allowed")


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/api/nope", id="unknown"),
        pytest.param("/api/nope/deeper", id="unknown, nested"),
        pytest.param("/api/", id="the API root"),
    ],
)
async def test_an_unknown_api_path_is_a_404(path):
    await assert_error(await AsyncClient(**CLIENT_ARGS).get(path), 404, "not_found")


async def test_an_unexpected_exception_answers_without_any_detail(monkeypatch, caplog):
    async def broken(*args, **kwargs):
        raise RuntimeError("secret internal detail at /srv/app/planner.py")

    monkeypatch.setattr(api_module, "plan_routes", broken)
    body = {
        "origin": {"lat": 34.05, "lon": -118.24},
        "destination": {"lat": 40.71, "lon": -74.0},
        "departure": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
        "load_lb": 60_000,
        "checkpoint_interval_miles": 50,
    }

    response = await AsyncClient(**CLIENT_ARGS).post(
        "/api/routes", data=json.dumps(body), content_type="application/json"
    )

    await assert_error(response, 500, "internal_error")
    assert "secret" not in response.content.decode()
    assert "Traceback" not in response.content.decode()
    assert "secret internal detail" in caplog.text  # the detail goes to the log, not the client


async def test_a_path_outside_the_api_is_left_alone():
    response = await AsyncClient(**CLIENT_ARGS).get("/somewhere-else")

    assert response.status_code == 404
    assert not response["Content-Type"].startswith("application/json")


async def test_every_operation_declares_every_error_status_and_the_body():
    schema = (await AsyncClient().get("/api/openapi.json")).json()

    for path, operations in schema["paths"].items():
        for operation in operations.values():
            responses = operation["responses"]
            assert {"404", "405", "422", "500"} <= set(responses), path
            assert "ErrorOut" in json.dumps(responses["500"])
