import asyncio

import httpx
import pytest

from providers import outbound as outbound_module
from providers.errors import (
    MalformedResponse,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)
from providers.outbound import ConnectPolicy, Outbound, UpstreamBadRequest

URL = "https://api.tomtom.com/slow"

METHODS = ["GET", "POST"]
CONNECTING = ConnectPolicy(timeout_s=3, attempts=4)


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


class Sleeps(list):
    """A sleep that records how long it was asked for and returns at once."""

    async def __call__(self, seconds):
        self.append(seconds)


class Clock:
    """A clock that moves only when a test moves it."""

    def __init__(self):
        self.now = 100.0

    def monotonic(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(outbound_module, "time", clock)
    return clock


async def test_the_logged_elapsed_runs_from_the_first_attempt_to_the_end(
    provider_mock, caplog, clock
):
    def slow_timeout(request):
        clock.now += 6.25
        raise httpx.ReadTimeout("x")

    provider_mock.get(URL).mock(side_effect=slow_timeout)

    with caplog.at_level("WARNING", logger="providers.outbound"):
        async with Outbound() as outbound:
            with pytest.raises(ProviderTimeout):
                await outbound.get_json(URL, {}, timeout=5)

    assert [r.getMessage() for r in caplog.records] == [
        "provider call timed out: host=api.tomtom.com, kind=ReadTimeout, attempts=2, elapsed=12.5 s"
    ]


async def test_the_logged_elapsed_does_not_count_the_wait_for_a_slot(provider_mock, caplog, clock):
    calls = 0

    async def answer(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            await asyncio.sleep(0.01)  # the second call queues for the only slot meanwhile
            clock.now += 50
            return httpx.Response(200, json={})
        clock.now += 12
        raise httpx.ConnectTimeout("x")

    provider_mock.get(URL).mock(side_effect=answer)

    with caplog.at_level("WARNING", logger="providers.outbound"):
        async with Outbound(max_concurrent=1) as outbound:
            results = await asyncio.gather(
                outbound.get_json(URL, {}, timeout=5, retry=False),
                outbound.get_json(URL, {}, timeout=5, retry=False),
                return_exceptions=True,
            )

    assert isinstance(results[1], ProviderTimeout)
    assert caplog.records[0].getMessage().endswith("attempts=1, elapsed=12.0 s")


async def test_the_connect_timeout_is_ten_seconds_unless_the_caller_asks_for_less(provider_mock):
    seen = []

    async def record(request):
        seen.append(request.extensions["timeout"])
        return httpx.Response(200, json={})

    provider_mock.get(URL).mock(side_effect=record)

    async with Outbound() as outbound:
        await outbound.get_json(URL, {}, timeout=12)
        await outbound.get_json(URL, {}, timeout=12, connect=CONNECTING)

    assert [(t["connect"], t["read"]) for t in seen] == [(10.0, 12), (3, 12)]


def test_a_connection_needs_at_least_one_try():
    with pytest.raises(ValueError):
        ConnectPolicy(attempts=0)


async def test_by_default_a_connect_failure_is_one_try_per_attempt(provider_mock):
    route = provider_mock.get(URL).mock(side_effect=httpx.ConnectTimeout("x"))

    async with Outbound() as outbound:
        with pytest.raises(ProviderTimeout):
            await outbound.get_json(URL, {}, timeout=5, retry=False)

    assert route.call_count == 1


@pytest.mark.parametrize("retry", [True, False])
async def test_a_connection_that_opens_on_the_last_try_gives_the_answer(provider_mock, retry):
    route = provider_mock.get(URL).mock(
        side_effect=[httpx.ConnectTimeout("x")] * 3 + [httpx.Response(200, json={"ok": True})]
    )

    async with Outbound() as outbound:
        answer = await outbound.get_json(URL, {}, timeout=5, retry=retry, connect=CONNECTING)

    assert answer == {"ok": True}
    assert route.call_count == 4


@pytest.mark.parametrize(
    ("error", "failure"),
    [
        (httpx.ConnectTimeout("x"), ProviderTimeout),
        (httpx.ConnectError("x"), ProviderUnavailable),
    ],
)
async def test_connect_tries_do_not_multiply_with_the_retry(provider_mock, error, failure):
    route = provider_mock.get(URL).mock(side_effect=error)

    async with Outbound(sleep=Sleeps()) as outbound:
        with pytest.raises(failure):
            await outbound.get_json(URL, {}, timeout=5, connect=CONNECTING)

    assert route.call_count == 4


async def test_a_retry_gets_a_fresh_connect_budget(provider_mock):
    route = provider_mock.get(URL).mock(
        side_effect=[httpx.ConnectTimeout("x")] * 2
        + [httpx.Response(503)]
        + [httpx.ConnectTimeout("x")] * 4
    )

    async with Outbound() as outbound:
        with pytest.raises(ProviderTimeout):
            await outbound.get_json(URL, {}, timeout=5, connect=CONNECTING)

    assert route.call_count == 7


@pytest.mark.parametrize(
    ("error", "failure", "pauses"),
    [
        (httpx.ConnectTimeout("x"), ProviderTimeout, []),
        (httpx.ConnectError("x"), ProviderUnavailable, [0.25, 0.5, 0.5]),
    ],
)
async def test_only_a_refused_connection_pauses_before_the_next_try(
    provider_mock, error, failure, pauses
):
    provider_mock.get(URL).mock(side_effect=error)
    sleeps = Sleeps()

    async with Outbound(sleep=sleeps) as outbound:
        with pytest.raises(failure):
            await outbound.get_json(URL, {}, timeout=5, connect=CONNECTING)

    assert sleeps == pauses


async def test_a_connection_that_never_opens_logs_every_try(provider_mock, caplog):
    provider_mock.get(URL).mock(side_effect=httpx.ConnectError("x"))

    with caplog.at_level("WARNING", logger="providers.outbound"):
        async with Outbound(sleep=Sleeps()) as outbound:
            with pytest.raises(ProviderUnavailable):
                await outbound.get_json(URL, {}, timeout=5, connect=CONNECTING)

    assert [r.getMessage() for r in caplog.records] == [
        "provider call failed: host=api.tomtom.com, kind=ConnectError, attempts=4, elapsed=0.0 s"
    ]
