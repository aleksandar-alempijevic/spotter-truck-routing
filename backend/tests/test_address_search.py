import json
import logging

import httpx
import pytest
from django.test import AsyncClient

from providers import Outbound, autocomplete
from providers.errors import ProviderNotConfigured

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
    assert params["type"] == "city"
    assert route.calls.last.request.extensions["timeout"]["read"] == 10


async def test_a_timezone_given_as_a_plain_name_is_accepted(provider_mock):
    respond(provider_mock, place(timezone="America/Denver"))

    assert (await search()).json()["suggestions"][0]["timezone"] == "America/Denver"


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param({"timezone": None}, id="no time zone"),
        pytest.param({"timezone": {}}, id="time zone without a name"),
        pytest.param({"timezone": ""}, id="empty time zone"),
        pytest.param({"formatted": ""}, id="empty label"),
        pytest.param({"formatted": None}, id="no label"),
        pytest.param({"lat": None}, id="no latitude"),
        pytest.param({"lat": "37"}, id="latitude as text"),
        pytest.param({"lon": 400}, id="longitude out of range"),
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


@pytest.mark.parametrize(
    "q",
    [
        pytest.param("", id="empty"),
        pytest.param("ab", id="2 characters"),
        pytest.param("  a ", id="2 after trimming"),
        pytest.param("x" * 101, id="101 characters"),
    ],
)
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


@pytest.mark.parametrize(
    ("typed", "sent"),
    [
        pytest.param("abc", "abc", id="exactly 3 characters"),
        pytest.param("x" * 100, "x" * 100, id="exactly 100 characters"),
        pytest.param("  abc  ", "abc", id="3 characters with padding"),
        pytest.param("  Dallas  ", "Dallas", id="padded word"),
    ],
)
async def test_text_within_the_limits_is_accepted_and_sent_trimmed(provider_mock, typed, sent):
    route = respond(provider_mock)

    response = await search(typed)

    assert response.status_code == 200
    assert route.calls.last.request.url.params["text"] == sent


async def test_a_missing_key_is_a_clear_error(settings):
    settings.GEOAPIFY_API_KEY = ""

    response = await search()

    assert response.status_code == 503
    assert response.json()["code"] == "provider_not_configured"


async def test_the_adapter_refuses_an_empty_key():
    async with Outbound() as outbound:
        with pytest.raises(ProviderNotConfigured):
            await autocomplete(outbound, "", "Dallas")


@pytest.mark.parametrize(
    "upstream",
    [
        pytest.param(httpx.Response(400, json={"message": f"bad {KEY}"}), id="400"),
        pytest.param(httpx.Response(200, text="<html>"), id="not JSON"),
        pytest.param(httpx.Response(200, json={"nothing": 1}), id="no results"),
        pytest.param(httpx.Response(200, json={"results": "no"}), id="results not a list"),
        pytest.param(httpx.Response(200, json=[1, 2]), id="body not an object"),
    ],
)
async def test_geoapifys_own_failures_are_gateway_errors(provider_mock, upstream):
    provider_mock.get(host="api.geoapify.com").mock(return_value=upstream)

    response = await search()

    assert response.status_code == 502
    assert response.json()["code"] in {"provider_unavailable", "provider_malformed_response"}


async def test_a_failed_call_is_made_once(provider_mock):
    route = provider_mock.get(host="api.geoapify.com").mock(return_value=httpx.Response(500))

    assert (await search()).status_code == 502
    assert route.call_count == 1


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


def sent(route) -> list[dict]:
    return [dict(call.request.url.params) for call in route.calls]


async def test_text_without_a_digit_searches_cities_with_the_country_filter(provider_mock):
    route = respond(provider_mock, place())

    response = await search("Salt Lake")

    assert response.status_code == 200
    (only,) = sent(route)
    assert only["type"] == "city"
    assert only["filter"] == "countrycode:us"
    assert only["text"] == "Salt Lake"


async def test_an_empty_city_search_falls_back_once_to_the_untyped_search(provider_mock):
    route = provider_mock.get(host="api.geoapify.com").mock(
        side_effect=[
            httpx.Response(200, json={"results": []}),
            httpx.Response(200, json={"results": [place(formatted="Pilot Travel Center, KS")]}),
        ]
    )

    response = await search("Pilot Travel Center")

    assert [s["label"] for s in response.json()["suggestions"]] == ["Pilot Travel Center, KS"]
    first, second = sent(route)
    assert first["type"] == "city"
    assert "type" not in second
    assert second["filter"] == "countrycode:us"
    assert route.calls.last.request.extensions["timeout"]["read"] == 10


async def test_a_city_search_that_finds_something_makes_no_second_call(provider_mock):
    route = respond(provider_mock, place())

    await search("Spokane, W")

    assert route.call_count == 1


async def test_a_city_search_whose_results_are_all_unusable_also_falls_back(provider_mock):
    route = provider_mock.get(host="api.geoapify.com").mock(
        side_effect=[
            httpx.Response(200, json={"results": [place(timezone=None)]}),
            httpx.Response(200, json={"results": [place()]}),
        ]
    )

    assert len((await search("Spring")).json()["suggestions"]) == 1
    assert route.call_count == 2


async def test_when_both_searches_are_empty_the_answer_is_empty_after_exactly_two_calls(
    provider_mock,
):
    route = respond(provider_mock)

    response = await search("zzzzzz")

    assert response.status_code == 200
    assert response.json()["suggestions"] == []
    assert route.call_count == 2


async def test_a_failed_city_search_is_an_error_and_is_not_retried_untyped(provider_mock):
    route = provider_mock.get(host="api.geoapify.com").mock(return_value=httpx.Response(500))

    response = await search("Spring")

    assert response.status_code == 502
    assert route.call_count == 1


async def test_text_that_starts_with_a_number_keeps_the_untyped_search(
    provider_mock,
):
    route = respond(provider_mock, place(formatted="1600 Pennsylvania Ave NW, Washington, DC"))

    await search("1600 Pennsylvania")

    (only,) = sent(route)
    assert "type" not in only
    assert only["filter"] == "countrycode:us"
    assert route.calls.last.request.extensions["timeout"]["read"] == 10


async def test_a_numeric_search_that_finds_nothing_is_not_repeated(provider_mock):
    route = respond(provider_mock)

    await search("99999 nowhere")

    assert route.call_count == 1


async def test_a_digit_later_in_the_text_is_untyped_with_the_same_deadline(provider_mock):
    route = respond(provider_mock, place())

    await search("Route 66, Tulsa")

    (only,) = sent(route)
    assert "type" not in only
    assert route.calls.last.request.extensions["timeout"]["read"] == 10


async def test_a_numeric_search_that_times_out_is_a_gateway_timeout(provider_mock):
    provider_mock.get(host="api.geoapify.com").mock(side_effect=httpx.ReadTimeout("slow"))

    response = await search("1600 Pennsylvania")

    assert response.status_code == 504
    assert response.json()["code"] == "provider_timeout"
