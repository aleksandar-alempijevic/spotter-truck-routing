import json
import logging

import httpx
import pytest
from django.test import AsyncClient

from providers import Outbound, ProviderNotConfigured, autocomplete

KEY = "test-geoapify-key"


def place(**overrides) -> dict:
    result = {
        "formatted": "Springfield, MO, United States of America",
        "lat": 37.2153,
        "lon": -93.2982,
        "country_code": "us",
        "result_type": "city",
        "timezone": {"name": "America/Chicago", "offset_STD": "-06:00"},
    }
    return {**result, **overrides}


def respond(provider_mock, *results, status=200):
    return provider_mock.get(host="api.geoapify.com").respond(
        status, json={"results": list(results), "query": {}}
    )


async def search(q: str = "Spring"):
    return await AsyncClient().get("/api/address-search", {"q": q})


async def test_suggestions_carry_label_coordinates_zone_and_the_attribution(provider_mock):
    route = respond(
        provider_mock,
        place(),
        place(formatted="1 Main St, Springfield, IL 62701, United States", result_type="building"),
    )

    response = await search("Spring")

    body = response.json()
    assert response.status_code == 200
    assert body["suggestions"][0] == {
        "label": "Springfield, MO, United States of America",
        "lat": 37.2153,
        "lon": -93.2982,
        "timezone": "America/Chicago",
    }
    assert len(body["suggestions"]) == 2
    assert body["attribution"] == {
        "text": "Powered by Geoapify",
        "url": "https://www.geoapify.com/",
    }
    params = route.calls.last.request.url.params
    assert params["filter"] == "countrycode:us"
    assert params["text"] == "Spring"
    assert "type" not in params


async def test_a_timezone_given_as_a_plain_name_is_accepted(provider_mock):
    respond(provider_mock, place(timezone="America/Denver"))

    assert (await search()).json()["suggestions"][0]["timezone"] == "America/Denver"


@pytest.mark.parametrize(
    "bad",
    [
        {"timezone": None},
        {"timezone": {}},
        {"timezone": ""},
        {"formatted": ""},
        {"formatted": None},
        {"lat": None},
        {"lat": "37"},
        {"lon": 400},
    ],
)
async def test_a_suggestion_missing_something_the_ui_needs_is_dropped(provider_mock, bad):
    respond(provider_mock, place(**bad), place(formatted="Kept, TX, United States"))

    suggestions = (await search()).json()["suggestions"]

    assert [s["label"] for s in suggestions] == ["Kept, TX, United States"]


async def test_no_match_is_an_empty_list_not_an_error(provider_mock):
    respond(provider_mock)

    response = await search("zzzzzz")

    assert response.status_code == 200
    assert response.json()["suggestions"] == []
    assert response.json()["attribution"]["text"]


@pytest.mark.parametrize("q", ["", "ab", "  a ", "x" * 101])
async def test_text_outside_the_length_limits_is_rejected_before_any_provider_call(
    provider_mock, q
):
    response = await search(q)

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert provider_mock.calls.call_count == 0


async def test_a_missing_text_is_a_validation_error():
    response = await AsyncClient().get("/api/address-search")

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


async def test_the_text_is_trimmed_before_it_is_sent(provider_mock):
    route = respond(provider_mock)

    await search("  Dallas  ")

    assert route.calls.last.request.url.params["text"] == "Dallas"


async def test_a_missing_key_is_a_clear_error(settings):
    settings.GEOAPIFY_API_KEY = ""

    response = await search()

    assert response.status_code == 503
    assert response.json()["code"] == "provider_not_configured"


async def test_the_adapter_refuses_an_empty_key():
    async with Outbound() as outbound:
        with pytest.raises(ProviderNotConfigured):
            await autocomplete(outbound, "", "Dallas")


async def test_a_failed_call_is_not_retried(provider_mock):
    route = provider_mock.get(host="api.geoapify.com").mock(return_value=httpx.Response(500))

    response = await search()

    assert response.status_code == 502
    assert route.call_count == 1


@pytest.mark.parametrize(
    ("upstream", "status", "code"),
    [
        (httpx.Response(400, json={"message": f"bad {KEY}"}), 502, "provider_unavailable"),
        (httpx.Response(400, text=KEY), 502, "provider_unavailable"),
        (httpx.Response(401, text=KEY), 503, "provider_limited"),
        (httpx.Response(403), 503, "provider_limited"),
        (httpx.Response(429), 503, "provider_limited"),
        (httpx.Response(404), 502, "provider_unavailable"),
        (httpx.Response(500, text=f"the key is {KEY}"), 502, "provider_unavailable"),
        (httpx.Response(200, text="<html>"), 502, "provider_malformed_response"),
        (httpx.Response(200, json={"nothing": 1}), 502, "provider_malformed_response"),
        (httpx.Response(200, json={"results": "no"}), 502, "provider_malformed_response"),
        (httpx.Response(200, json=[1, 2]), 502, "provider_malformed_response"),
        (httpx.ReadTimeout(f"slow {KEY}"), 504, "provider_timeout"),
        (httpx.ConnectError(f"cannot reach {KEY}"), 502, "provider_unavailable"),
    ],
)
async def test_provider_failures_surface_as_api_errors_without_the_key(
    provider_mock, caplog, upstream, status, code
):
    caplog.set_level(logging.DEBUG)
    route = provider_mock.get(host="api.geoapify.com")
    if isinstance(upstream, Exception):
        route.mock(side_effect=upstream)
    else:
        route.mock(return_value=upstream)

    response = await search()

    assert response.status_code == status
    assert set(response.json()) == {"code", "message"}
    assert response.json()["code"] == code
    assert KEY not in response.content.decode()
    assert KEY not in caplog.text


async def test_the_key_appears_in_no_log_record_or_body_on_success(provider_mock, caplog):
    caplog.set_level(logging.DEBUG)
    respond(provider_mock, place())

    response = await search()

    assert response.status_code == 200
    assert KEY not in response.content.decode()
    assert KEY not in caplog.text


async def test_the_openapi_schema_declares_the_endpoint_and_its_errors():
    schema = (await AsyncClient().get("/api/openapi.json")).json()

    responses = schema["paths"]["/api/address-search"]["get"]["responses"]
    assert {"200", "422", "502", "503", "504"} <= set(responses)
    assert json.dumps(responses["200"]).count("AddressSearchOut") == 1
