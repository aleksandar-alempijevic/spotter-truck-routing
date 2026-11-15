import json
from datetime import UTC, datetime
from urllib.parse import parse_qs

import httpx
import pytest

from providers import Outbound
from providers.errors import (
    MalformedResponse,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)
from providers.openmeteo import MAX_LOCATIONS_PER_CALL, fetch_forecasts
from tests.open_meteo_fixtures import STAMPS, location
from weather import ForecastSeries


async def fetch(points):
    async with Outbound() as outbound:
        return await fetch_forecasts(outbound, points)


def mock(provider_mock, body=None, **kwargs):
    route = provider_mock.post(host="api.open-meteo.com")
    return route.respond(json=body, **kwargs) if body is not None else route.respond(**kwargs)


async def test_the_request_is_a_form_post_of_the_chunk_in_mph_and_inches(provider_mock):
    route = mock(provider_mock, [location(), location()])

    await fetch([(39.75, -104.95), (40.25, -99.35)])

    request = route.calls.last.request
    form = parse_qs(request.content.decode())
    assert request.method == "POST"
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    assert request.url.query == b""
    assert form["latitude"] == ["39.75,40.25"]
    assert form["longitude"] == ["-104.95,-99.35"]
    assert form["hourly"] == ["wind_speed_10m,wind_gusts_10m,precipitation,snowfall"]
    assert form["wind_speed_unit"] == ["mph"]
    assert form["precipitation_unit"] == ["inch"]
    assert form["timezone"] == ["UTC"]
    assert form["forecast_hours"] == ["96"]
    assert form["models"] == ["best_match"]
    assert request.headers["user-agent"] == "truck-route-weather"
    assert request.extensions["timeout"]["read"] == 12


async def test_a_series_comes_back_for_each_point_in_request_order(provider_mock):
    first = location(latitude=1.0)
    second = location(hourly={"wind_speed_10m": [1.0, 2.0, 3.0]}, latitude=1.0)
    mock(provider_mock, [first, second])

    series = await fetch([(39.75, -104.95), (40.25, -99.35)])

    assert [s.wind_mph for s in series] == [(10.0, 20.0, 30.0), (1.0, 2.0, 3.0)]
    assert all(isinstance(s, ForecastSeries) for s in series)
    assert series[0].start == datetime(2026, 11, 13, 14, 0, tzinfo=UTC)


async def test_a_single_location_answers_with_a_bare_object(provider_mock):
    mock(provider_mock, location())

    series = await fetch([(39.75, -104.95)])

    assert len(series) == 1 and series[0].gust_mph == (15.0, 25.0, 35.0)


async def test_rain_is_precipitation_less_the_water_in_the_snow_and_never_below_zero(
    provider_mock,
):
    body = location(
        hourly={"precipitation": [0.307, 0.5, 0.1], "snowfall": [2.15, 0.7, 0.0]},
    )
    mock(provider_mock, body)

    series = (await fetch([(39.75, -104.95)]))[0]

    assert series.rain_in_per_hr == pytest.approx((0.0, 0.4, 0.1))
    assert series.snow_in_per_hr == (2.15, 0.7, 0.0)


async def test_a_null_stays_absent_and_is_not_read_as_zero(provider_mock):
    body = location(
        hourly={
            "wind_speed_10m": [None, 20.0, 30.0],
            "precipitation": [None, 0.5, 0.0],
            "snowfall": [0.0, None, 0.0],
        }
    )
    mock(provider_mock, body)

    series = (await fetch([(39.75, -104.95)]))[0]

    assert series.wind_mph[0] is None
    assert series.rain_in_per_hr[:2] == (None, None)
    assert series.snow_in_per_hr[1] is None
    assert series.rain_in_per_hr[2] == 0.0


@pytest.mark.parametrize(
    "body",
    [
        pytest.param("not a list or object", id="a string"),
        pytest.param([location()], id="fewer series than points"),
        pytest.param([location(), location(), location()], id="more series than points"),
        pytest.param([location(), "x"], id="a series that is not an object"),
        pytest.param(
            [location(), location(hourly_units={"wind_speed_10m": "mph"})], id="other wind unit"
        ),
        pytest.param([location(), location(hourly_units={"snowfall": "cm"})], id="other snow unit"),
        pytest.param([location(), {"hourly": location()["hourly"]}], id="no units"),
        pytest.param([location(), {"hourly_units": location()["hourly_units"]}], id="no hourly"),
        pytest.param(
            [location(), location(hourly={"time": STAMPS[:2]})], id="a column longer than the time"
        ),
        pytest.param(
            [location(), location(hourly={"time": [STAMPS[0], STAMPS[2], STAMPS[1]]})],
            id="stamps out of order",
        ),
        pytest.param(
            [location(), location(hourly={"time": [STAMPS[0], STAMPS[2], "2026-11-13T17:00"]})],
            id="a gap in the stamps",
        ),
        pytest.param(
            [location(), location(hourly={"time": ["2026-11-13T14:30", *STAMPS[1:]]})],
            id="stamps off the hour",
        ),
        pytest.param(
            [location(), location(hourly={"time": ["soon", *STAMPS[1:]]})], id="unparsable stamp"
        ),
        pytest.param([location(), location(hourly={"time": []})], id="no stamps"),
        pytest.param(
            [location(), location(hourly={"wind_gusts_10m": "gusty"})], id="column not a list"
        ),
        pytest.param(
            [location(), location(hourly={"wind_gusts_10m": [1.0, "2", 3.0]})], id="text value"
        ),
        pytest.param(
            [location(), location(hourly={"wind_gusts_10m": [1.0, True, 3.0]})], id="boolean value"
        ),
    ],
)
async def test_a_response_that_cannot_be_trusted_is_malformed(provider_mock, body):
    mock(provider_mock, body)

    with pytest.raises(MalformedResponse):
        await fetch([(39.75, -104.95), (40.25, -99.35)])


async def test_a_missing_column_is_malformed(provider_mock):
    body = location()
    del body["hourly"]["snowfall"]
    mock(provider_mock, body)

    with pytest.raises(MalformedResponse):
        await fetch([(39.75, -104.95)])


async def test_a_non_finite_value_is_malformed(provider_mock):
    text = json.dumps(location()).replace("20.0", "NaN", 1)
    mock(provider_mock, content=text.encode(), headers={"content-type": "application/json"})

    with pytest.raises(MalformedResponse):
        await fetch([(39.75, -104.95)])


async def test_a_400_is_unavailable_and_says_nothing_of_the_upstream(provider_mock):
    reason = {"error": True, "reason": "Latitude must be in range of -90 to 90"}
    route = mock(provider_mock, reason, status_code=400)

    with pytest.raises(ProviderUnavailable) as caught:
        await fetch([(39.75, -104.95)])

    assert "Latitude" not in str(caught.value) and "open-meteo" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert route.call_count == 1


async def test_a_429_is_rate_limited_and_carries_the_retry_delay_as_data(provider_mock):
    route = mock(provider_mock, {"error": True}, status_code=429, headers={"Retry-After": "12"})

    with pytest.raises(ProviderRateLimited) as caught:
        await fetch([(39.75, -104.95)])

    assert caught.value.retry_after_s == 12.0
    assert "12" not in str(caught.value) and "open-meteo" not in str(caught.value).lower()
    assert route.call_count == 1


async def test_a_5xx_is_retried_once(provider_mock):
    route = provider_mock.post(host="api.open-meteo.com").mock(
        side_effect=[httpx.Response(502), httpx.Response(200, json=location())]
    )

    assert len(await fetch([(39.75, -104.95)])) == 1
    assert route.call_count == 2


@pytest.mark.parametrize("count", [0, MAX_LOCATIONS_PER_CALL + 1])
async def test_a_chunk_outside_the_call_size_is_refused_before_any_request(provider_mock, count):
    route = mock(provider_mock, location())

    with pytest.raises(ValueError):
        await fetch([(39.75, -104.95)] * count)

    assert route.call_count == 0


async def test_a_connection_is_tried_four_times_at_three_seconds_and_then_not_retried(
    provider_mock,
):
    route = provider_mock.post(host="api.open-meteo.com").mock(
        side_effect=httpx.ConnectTimeout("x")
    )

    with pytest.raises(ProviderTimeout):
        await fetch([(40.0, -100.0)])

    assert route.call_count == 4
    assert route.calls[0].request.extensions["timeout"]["connect"] == 3.0
