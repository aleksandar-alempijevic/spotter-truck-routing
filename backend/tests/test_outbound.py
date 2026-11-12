import asyncio

import httpx
import pytest

from providers import Outbound

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


async def test_a_client_is_not_shared_between_requests():
    async with Outbound() as first, Outbound() as second:
        assert first._client is not second._client
