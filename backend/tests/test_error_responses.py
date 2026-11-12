"""Every upstream failure, on both endpoints: the API's answer and that no key leaks."""

import json
import logging
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from django.test import AsyncClient

ROUTES_BODY = {
    "origin": {"lat": 34.05, "lon": -118.24},
    "destination": {"lat": 40.71, "lon": -74.0},
    "departure": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
    "load_lb": 60_000,
    "checkpoint_interval_miles": 50,
}


async def call_routes():
    return await AsyncClient().post(
        "/api/routes", data=json.dumps(ROUTES_BODY), content_type="application/json"
    )


async def call_address_search():
    return await AsyncClient().get("/api/address-search", {"q": "Dallas"})


ENDPOINTS = [
    pytest.param(call_routes, "api.tomtom.com", "test-tomtom-key", id="routes"),
    pytest.param(call_address_search, "api.geoapify.com", "test-geoapify-key", id="address-search"),
]


def failures(key: str) -> dict[str, tuple[httpx.Response | Exception, int, str]]:
    return {
        "400": (
            httpx.Response(400, json={"message": f"bad with {key}"}),
            502,
            "provider_unavailable",
        ),
        "401": (httpx.Response(401, text=key), 503, "provider_limited"),
        "403": (httpx.Response(403), 503, "provider_limited"),
        "429": (httpx.Response(429), 503, "provider_limited"),
        "404": (httpx.Response(404), 502, "provider_unavailable"),
        "500": (httpx.Response(500, text=f"the key is {key}"), 502, "provider_unavailable"),
        "not JSON": (httpx.Response(200, text="<html>"), 502, "provider_malformed_response"),
        "timeout": (httpx.ReadTimeout(f"slow {key}"), 504, "provider_timeout"),
        "connect error": (
            httpx.ConnectError(f"cannot reach host with {key}"),
            502,
            "provider_unavailable",
        ),
    }


@pytest.mark.parametrize(("call", "host", "key"), ENDPOINTS)
@pytest.mark.parametrize("failure", list(failures("")))
async def test_a_provider_failure_is_an_api_error_and_the_key_stays_out(
    provider_mock, caplog, call, host, key, failure
):
    upstream, status, code = failures(key)[failure]
    caplog.set_level(logging.DEBUG)
    route = provider_mock.get(host=host)
    if isinstance(upstream, Exception):
        route.mock(side_effect=upstream)
    else:
        route.mock(return_value=upstream)

    response = await call()

    assert response.status_code == status
    assert response.json().keys() == {"code", "message"}
    assert response.json()["code"] == code
    assert key not in response.content.decode()
    assert key not in caplog.text
