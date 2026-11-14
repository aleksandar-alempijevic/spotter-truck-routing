"""Every response under /api/ is `{code, message}`, including those no endpoint produces."""

import json
import logging
import typing
from datetime import UTC, datetime, timedelta

import pytest
from django.conf import settings
from django.http import Http404, HttpRequest, HttpResponse, JsonResponse
from django.test import AsyncClient

from api import api as api_module
from api.middleware import ApiErrorBodies
from api.schemas import ErrorCode

CLIENT_ARGS = {"raise_request_exception": False}
VALID_ROUTES_BODY = {
    "origin": {"lat": 34.05, "lon": -118.24},
    "destination": {"lat": 40.71, "lon": -74.0},
    "departure": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
    "load_lb": 45_000,
    "checkpoint_interval_miles": 50,
}
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
    ("method", "path", "allowed"),
    [
        pytest.param("get", "/api/routes", "POST", id="GET on the routes endpoint"),
        pytest.param("post", "/api/health", "GET", id="POST on health"),
        pytest.param("post", "/api/address-search", "GET", id="POST on address search"),
    ],
)
async def test_a_wrong_method_is_a_405(method, path, allowed):
    response = await getattr(AsyncClient(**CLIENT_ARGS), method)(path)

    await assert_error(response, 405, "method_not_allowed")
    assert response["Allow"] == allowed


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
    response = await AsyncClient(**CLIENT_ARGS).post(
        "/api/routes", data=json.dumps(VALID_ROUTES_BODY), content_type="application/json"
    )

    await assert_error(response, 500, "internal_error")
    assert "secret" not in response.content.decode()
    assert "Traceback" not in response.content.decode()
    assert "secret internal detail" in caplog.text  # the detail goes to the log, not the client


async def test_a_body_over_the_upload_limit_is_a_client_fault_and_logs_no_error(caplog):
    too_big = '{"origin": "' + "a" * (settings.DATA_UPLOAD_MAX_MEMORY_SIZE + 1) + '"}'

    response = await AsyncClient(**CLIENT_ARGS).post(
        "/api/routes", data=too_big, content_type="application/json"
    )

    await assert_error(response, 422, "validation_error")
    assert "too large" in response.json()["message"]
    assert [r for r in caplog.records if r.levelno >= logging.ERROR] == []


async def test_a_django_404_raised_inside_an_endpoint_has_the_error_body(monkeypatch):
    async def missing(*args, **kwargs):
        raise Http404("some internal detail")

    monkeypatch.setattr(api_module, "plan_routes", missing)

    response = await AsyncClient(**CLIENT_ARGS).post(
        "/api/routes", data=json.dumps(VALID_ROUTES_BODY), content_type="application/json"
    )

    await assert_error(response, 404, "not_found")
    assert "internal detail" not in response.content.decode()


def answer_through_middleware(response: HttpResponse) -> HttpResponse:
    request = HttpRequest()
    request.path = "/api/x"
    return ApiErrorBodies(lambda _request: response)(request)


def test_an_error_status_with_another_body_shape_is_replaced_whichever_layer_made_it():
    ninja_404 = answer_through_middleware(JsonResponse({"detail": "Not Found"}, status=404))
    html_500 = answer_through_middleware(HttpResponse("<html>boom</html>", status=500))
    extra_key = answer_through_middleware(
        JsonResponse({"code": "x", "message": "m", "extra": 1}, status=400)
    )

    assert json.loads(ninja_404.content) == {
        "code": "not_found",
        "message": "There is no such API path.",
    }
    assert json.loads(html_500.content)["code"] == "internal_error"
    assert extra_key.status_code == 500


def test_a_response_that_already_has_the_error_body_or_is_not_an_error_is_left_alone():
    good = JsonResponse({"code": "validation_error", "message": "m"}, status=422)
    fine = HttpResponse("plain", status=200)

    assert answer_through_middleware(good) is good
    assert answer_through_middleware(fine) is fine


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
