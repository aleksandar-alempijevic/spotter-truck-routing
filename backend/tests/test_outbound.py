import asyncio

import httpx
import pytest

from providers.errors import (
    MalformedResponse,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)
from providers.outbound import Outbound, UpstreamBadRequest

URL = "https://api.tomtom.com/slow"


async def test_the_cap_limits_calls_in_flight(provider_mock):
    in_flight = peak = 0

    async def slow(request):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return httpx.Response(200, json={})

    provider_mock.get(URL).mock(side_effect=slow)

    async with Outbound(max_concurrent=2) as outbound:
        await asyncio.gather(*(outbound.get_json(URL, {}, timeout=5) for _ in range(8)))

    assert peak == 2


async def test_waiters_queue_behind_a_slow_call_instead_of_timing_out(provider_mock):
    async def slow(request):
        await asyncio.sleep(0.05)
        return httpx.Response(200, json={"ok": True})

    provider_mock.get(URL).mock(side_effect=slow)

    async with Outbound(max_concurrent=1) as outbound:
        results = await asyncio.gather(*(outbound.get_json(URL, {}, timeout=5) for _ in range(3)))

    assert results == [{"ok": True}] * 3


async def test_the_client_is_closed_when_the_request_is_cancelled(provider_mock, monkeypatch):
    closed = 0
    real_aclose = httpx.AsyncClient.aclose

    async def counting_aclose(self):
        nonlocal closed
        closed += 1
        await real_aclose(self)

    monkeypatch.setattr(httpx.AsyncClient, "aclose", counting_aclose)

    async def hang(request):
        await asyncio.sleep(30)

    provider_mock.get(URL).mock(side_effect=hang)

    async def use():
        async with Outbound() as outbound:
            await outbound.get_json(URL, {}, timeout=60)

    task = asyncio.ensure_future(use())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert closed == 1


async def test_each_request_closes_its_own_client(monkeypatch):
    closed = 0
    real_aclose = httpx.AsyncClient.aclose

    async def counting_aclose(self):
        nonlocal closed
        closed += 1
        await real_aclose(self)

    monkeypatch.setattr(httpx.AsyncClient, "aclose", counting_aclose)

    async with Outbound():
        pass
    async with Outbound(), Outbound():
        pass

    assert closed == 3


KEY = "secret-key-value"
BODY_WITH_KEY = {"message": f"echoes {KEY}"}


@pytest.mark.parametrize(
    ("upstream", "error", "calls"),
    [
        pytest.param(httpx.Response(401, json=BODY_WITH_KEY), ProviderRateLimited, 1, id="401"),
        pytest.param(httpx.Response(403), ProviderRateLimited, 1, id="403"),
        pytest.param(httpx.Response(429), ProviderRateLimited, 1, id="429"),
        pytest.param(httpx.Response(404), ProviderUnavailable, 1, id="404"),
        pytest.param(httpx.Response(500, text=KEY), ProviderUnavailable, 2, id="500"),
        pytest.param(httpx.Response(503), ProviderUnavailable, 2, id="503"),
        pytest.param(httpx.Response(200, text="<html>"), MalformedResponse, 1, id="not JSON"),
        pytest.param(httpx.Response(200, text="null"), MalformedResponse, 1, id="JSON null"),
        pytest.param(httpx.ReadTimeout(f"slow {KEY}"), ProviderTimeout, 2, id="timeout"),
        pytest.param(
            httpx.ConnectError(f"cannot reach {KEY}"), ProviderUnavailable, 2, id="connect error"
        ),
    ],
)
async def test_every_upstream_failure_becomes_a_neutral_error_and_only_some_are_retried(
    provider_mock, upstream, error, calls
):
    route = provider_mock.get(URL)
    if isinstance(upstream, Exception):
        route.mock(side_effect=upstream)
    else:
        route.mock(return_value=upstream)

    async with Outbound() as outbound:
        with pytest.raises(error) as caught:
            await outbound.get_json(URL, {}, timeout=5)

    assert route.call_count == calls
    assert KEY not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None or caught.value.__suppress_context__


async def test_a_400_is_handed_to_the_adapter_with_its_body_and_not_retried(provider_mock):
    route = provider_mock.get(URL).respond(400, json={"detailedError": {"code": "BAD_INPUT"}})

    async with Outbound() as outbound:
        with pytest.raises(UpstreamBadRequest) as caught:
            await outbound.get_json(URL, {}, timeout=5)

    assert caught.value.body == {"detailedError": {"code": "BAD_INPUT"}}
    assert route.call_count == 1


async def test_a_5xx_is_retried_once_and_a_good_second_answer_is_used(provider_mock):
    route = provider_mock.get(URL).mock(
        side_effect=[httpx.Response(500), httpx.Response(200, json={"ok": True})]
    )

    async with Outbound() as outbound:
        assert await outbound.get_json(URL, {}, timeout=5) == {"ok": True}

    assert route.call_count == 2


@pytest.mark.parametrize(
    "upstream",
    [
        pytest.param(httpx.Response(500), id="500"),
        pytest.param(httpx.ReadTimeout("slow"), id="timeout"),
    ],
)
async def test_a_call_made_without_retry_is_made_once(provider_mock, upstream):
    route = provider_mock.get(URL)
    if isinstance(upstream, Exception):
        route.mock(side_effect=upstream)
    else:
        route.mock(return_value=upstream)

    async with Outbound() as outbound:
        with pytest.raises((ProviderUnavailable, ProviderTimeout)):
            await outbound.get_json(URL, {}, timeout=5, retry=False)

    assert route.call_count == 1
