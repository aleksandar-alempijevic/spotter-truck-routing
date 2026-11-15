import asyncio
from types import SimpleNamespace

import httpx
import pytest

from providers import outbound as outbound_module
from providers.errors import (
    MalformedResponse,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)
from providers.outbound import Outbound, UpstreamBadRequest

URL = "https://api.tomtom.com/slow"

METHODS = ["GET", "POST"]


def send(outbound, method, **kwargs):
    """The call a method stands for: a GET with query parameters or a form POST."""
    if method == "GET":
        return outbound.get_json(URL, {}, **kwargs)
    return outbound.post_form(URL, {}, **kwargs)


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
@pytest.mark.parametrize("method", METHODS)
async def test_every_upstream_failure_becomes_a_neutral_error_and_only_some_are_retried(
    provider_mock, method, upstream, error, calls
):
    route = provider_mock.route(method=method, url=URL)
    if isinstance(upstream, Exception):
        route.mock(side_effect=upstream)
    else:
        route.mock(return_value=upstream)

    async with Outbound() as outbound:
        with pytest.raises(error) as caught:
            await send(outbound, method, timeout=5)

    assert route.call_count == calls
    assert KEY not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None or caught.value.__suppress_context__


@pytest.mark.parametrize("method", METHODS)
async def test_a_400_is_handed_to_the_adapter_with_its_body_and_not_retried(provider_mock, method):
    route = provider_mock.route(method=method, url=URL).respond(
        400, json={"detailedError": {"code": "BAD_INPUT"}}
    )

    async with Outbound() as outbound:
        with pytest.raises(UpstreamBadRequest) as caught:
            await send(outbound, method, timeout=5)

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


POST_URL = "https://api.open-meteo.com/v1/forecast"


async def test_a_form_post_sends_the_fields_as_a_form_body_and_returns_the_json(provider_mock):
    route = provider_mock.post(POST_URL).respond(json={"ok": True})

    async with Outbound() as outbound:
        result = await outbound.post_form(
            POST_URL, {"latitude": "1,2", "n": 3}, timeout=5, headers={"User-Agent": "tester"}
        )

    request = route.calls.last.request
    assert result == {"ok": True}
    assert request.content == b"latitude=1%2C2&n=3"
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    assert request.headers["user-agent"] == "tester"
    assert request.extensions["timeout"]["read"] == 5


async def test_a_form_post_shares_the_cap(provider_mock):
    in_flight = peak = 0

    async def slow(request):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return httpx.Response(200, json={})

    provider_mock.post(POST_URL).mock(side_effect=slow)

    async with Outbound(max_concurrent=2) as outbound:
        await asyncio.gather(*(outbound.post_form(POST_URL, {}, timeout=5) for _ in range(8)))

    assert peak == 2


@pytest.mark.parametrize(
    ("header", "seconds"),
    [
        pytest.param("12", 12.0, id="seconds"),
        pytest.param("0.5", 0.5, id="fraction"),
        pytest.param("0", 0.0, id="zero"),
        pytest.param("Wed, 21 Oct 2026 07:28:00 GMT", None, id="a date"),
        pytest.param("-5", None, id="negative"),
        pytest.param("nan", None, id="not finite"),
        pytest.param("soon", None, id="text"),
        pytest.param(None, None, id="absent"),
    ],
)
async def test_a_rate_limit_carries_the_retry_delay_it_was_given_as_data(
    provider_mock, header, seconds
):
    headers = {} if header is None else {"Retry-After": header}
    provider_mock.get(URL).respond(429, headers=headers)

    async with Outbound() as outbound:
        with pytest.raises(ProviderRateLimited) as caught:
            await outbound.get_json(URL, {}, timeout=5)

    assert caught.value.retry_after_s == seconds
    assert str(caught.value) == ProviderRateLimited.message


@pytest.mark.parametrize("status", [401, 403])
async def test_only_a_429_carries_a_retry_delay(provider_mock, status):
    provider_mock.get(URL).respond(status, headers={"Retry-After": "12"})

    async with Outbound() as outbound:
        with pytest.raises(ProviderRateLimited) as caught:
            await outbound.get_json(URL, {}, timeout=5)

    assert caught.value.retry_after_s is None


@pytest.mark.parametrize(
    ("error", "kind", "attempts", "retry"),
    [
        (httpx.ReadTimeout("x"), "ReadTimeout", 2, True),
        (httpx.ConnectTimeout("x"), "ConnectTimeout", 1, False),
    ],
)
async def test_a_call_that_ends_in_a_timeout_logs_host_kind_and_attempts_only(
    provider_mock, caplog, error, kind, attempts, retry
):
    url = "https://api.tomtom.com/route/12.34,-56.78/json"
    provider_mock.get(host="api.tomtom.com").mock(side_effect=error)

    with caplog.at_level("WARNING", logger="providers.outbound"):
        async with Outbound() as outbound:
            with pytest.raises(ProviderTimeout):
                await outbound.get_json(url, {"key": "SECRET"}, timeout=5, retry=retry)

    assert [r.getMessage() for r in caplog.records] == [
        f"provider call timed out: host=api.tomtom.com, kind={kind}, attempts={attempts}, "
        "elapsed=0.0 s"
    ]


async def test_a_call_that_fails_another_way_logs_no_timeout(provider_mock, caplog):
    provider_mock.get(URL).respond(503)

    with caplog.at_level("WARNING", logger="providers.outbound"):
        async with Outbound() as outbound:
            with pytest.raises(ProviderUnavailable):
                await outbound.get_json(URL, {}, timeout=5)

    assert caplog.records == []


async def test_the_logged_elapsed_runs_from_the_first_attempt_to_the_end(
    provider_mock, caplog, monkeypatch
):
    # The first reading starts the call and the second ends it; a third would be a restart.
    readings = iter([100.0, 112.5, 999.0])
    monkeypatch.setattr(outbound_module, "time", SimpleNamespace(monotonic=lambda: next(readings)))
    provider_mock.get(URL).mock(side_effect=httpx.ReadTimeout("x"))

    with caplog.at_level("WARNING", logger="providers.outbound"):
        async with Outbound() as outbound:
            with pytest.raises(ProviderTimeout):
                await outbound.get_json(URL, {}, timeout=5)

    assert [r.getMessage() for r in caplog.records] == [
        "provider call timed out: host=api.tomtom.com, kind=ReadTimeout, attempts=2, elapsed=12.5 s"
    ]
