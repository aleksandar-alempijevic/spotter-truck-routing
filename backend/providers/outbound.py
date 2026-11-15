"""Shared outbound HTTP policy: one client per planning request, a concurrency cap, a timeout,
one retry and quick connect retries, for GET and for form-encoded POST.

The providers carry their keys in the query string, and httpx logs the full URL of every request
at INFO level and puts it in its exception text. Every httpx failure is therefore turned into a
provider-neutral error without a URL or upstream body, and the project's `LOGGING` setting
(`config/base.py`) keeps the `httpx` and `httpcore` loggers at WARNING.
"""

import asyncio
import logging
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Self
from urllib.parse import urlsplit

import httpx

from .errors import (
    MalformedResponse,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)

MAX_CONCURRENT_CALLS = 4
"""Calls in flight at once within one planning request; further calls wait their turn."""

CONNECT_ERROR_PAUSES_S = (0.25, 0.5, 0.5)
"""The pause before each further connect try (the last repeats) after a refused connection or a
failed name lookup. A connect timeout needs none: the timeout already spaced its tries."""


@dataclass(frozen=True)
class ConnectPolicy:
    """How a connection is opened: the timeout of each try and the number of tries.

    The default is one try at 10 s. A caller whose host has shown connect failures asks for more
    tries at a shorter timeout; a call that then never connects is not retried again, so the
    connect tries and the retry of a failed answer do not multiply.
    """

    timeout_s: float = 10.0
    attempts: int = 1

    def __post_init__(self) -> None:
        if self.attempts < 1:
            raise ValueError("a connection needs at least one try")


DEFAULT_CONNECT = ConnectPolicy()

RETRY_STATUSES = range(500, 600)
RATE_LIMIT_STATUSES = {401, 403, 429}


class UpstreamBadRequest(Exception):
    """A provider answered 400. The adapter reads `body` and turns this into a neutral error.

    Never let this reach a response or a log: the body is the provider's own text.
    """

    def __init__(self, body: Any) -> None:
        super().__init__("provider answered 400")
        self.body = body


@dataclass
class _Tally:
    """What one call went through, for its log line: every try, and when its first one started."""

    attempts: int = 0
    started: float | None = None


class _ConnectTriesExhausted(Exception):
    """Every try of a multi-try `ConnectPolicy` failed to connect; `error` is the last failure."""

    def __init__(self, error: httpx.HTTPError) -> None:
        super().__init__()
        self.error = error


def _classify(error: httpx.HTTPError) -> tuple[type[Exception], str | None]:
    """The neutral error for a failed try, and its kind when the failure is worth a log line."""
    if isinstance(error, httpx.TimeoutException):
        return ProviderTimeout, type(error).__name__
    if isinstance(error, httpx.ConnectError):
        return ProviderUnavailable, type(error).__name__
    return ProviderUnavailable, None


class Outbound:
    """An async context manager owning one HTTP client and its concurrency cap.

    Open it inside the request's coroutine so the client is closed on every exit path, including
    the cancellation Django's ASGI handler applies when the browser disconnects. Calls wait on a
    semaphore, so a waiter can queue behind a slow call without a pool timeout cutting it off.
    """

    def __init__(
        self,
        max_concurrent: int = MAX_CONCURRENT_CALLS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._sleep = sleep
        self._client: httpx.AsyncClient | None = None
        self._slots = asyncio.Semaphore(max_concurrent)

    async def __aenter__(self) -> Self:
        self._client = httpx.AsyncClient(follow_redirects=False)
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        assert self._client is not None
        await self._client.aclose()
        self._client = None

    async def get_json(
        self,
        url: str,
        params: dict[str, Any],
        *,
        timeout: float,
        retry: bool = True,
        connect: ConnectPolicy = DEFAULT_CONNECT,
    ) -> Any:
        """GET a URL and return its parsed JSON.

        Retries once on a timeout, a transport error or a 5xx, never on a 4xx. A connection that
        cannot be opened is tried as `connect` says. Raises the
        neutral errors from `providers.errors`. A 400 raises `UpstreamBadRequest` so the adapter
        can tell its provider's cases apart.
        """
        return await self._call("GET", url, timeout, retry, connect, params=params)

    async def post_form(
        self,
        url: str,
        data: dict[str, Any],
        *,
        timeout: float,
        headers: dict[str, str] | None = None,
        connect: ConnectPolicy = DEFAULT_CONNECT,
    ) -> Any:
        """POST a form-encoded body and return the parsed JSON, under the same policy as
        `get_json`, with its retry. Used where a request would not fit in a URL."""
        return await self._call("POST", url, timeout, True, connect, data=data, headers=headers)

    async def _call(
        self,
        method: str,
        url: str,
        timeout: float,
        retry: bool,
        connect: ConnectPolicy,
        **content: Any,
    ) -> Any:
        tally = _Tally()
        retries_left = 1 if retry else 0
        while True:
            try:
                response = await self._send_connecting(
                    method, url, timeout, connect, content, tally
                )
            except _ConnectTriesExhausted as exhausted:
                failure, kind = _classify(exhausted.error)
                break  # the connect tries were the retry
            except httpx.HTTPError as error:
                failure, kind = _classify(error)
            else:
                if response.status_code not in RETRY_STATUSES:
                    return _decode(response)
                failure, kind = ProviderUnavailable, None
            if not retries_left:
                break
            retries_left -= 1
        if kind is not None:
            # The host only: the URL's query carries the key, and the path its coordinates.
            logger.warning(
                "provider call %s: host=%s, kind=%s, attempts=%d, elapsed=%.1f s",
                "timed out" if failure is ProviderTimeout else "failed",
                urlsplit(url).hostname,
                kind,
                tally.attempts,
                time.monotonic() - tally.started,
            )
        raise failure from None

    async def _send_connecting(
        self,
        method: str,
        url: str,
        timeout: float,
        connect: ConnectPolicy,
        content: dict[str, Any],
        tally: _Tally,
    ) -> httpx.Response:
        """One try's request, with up to `connect.attempts` tries to open its connection.

        Each try takes its own slot, so the clock in `tally` starts when the call first runs, not
        while it queues. A refused connection or a failed name lookup pauses before the next try;
        a connect timeout needs no pause. After the last try, a policy of several tries raises
        `_ConnectTriesExhausted`, and a policy of one raises the connect error itself.
        """
        for attempt in range(connect.attempts - 1):
            try:
                return await self._try(method, url, timeout, connect, content, tally)
            except httpx.ConnectError:
                await self._sleep(
                    CONNECT_ERROR_PAUSES_S[min(attempt, len(CONNECT_ERROR_PAUSES_S) - 1)]
                )
            except httpx.ConnectTimeout:
                pass
        try:
            return await self._try(method, url, timeout, connect, content, tally)
        except (httpx.ConnectTimeout, httpx.ConnectError) as error:
            if connect.attempts == 1:
                raise
            raise _ConnectTriesExhausted(error) from None

    async def _try(
        self,
        method: str,
        url: str,
        timeout: float,
        connect: ConnectPolicy,
        content: dict[str, Any],
        tally: _Tally,
    ) -> httpx.Response:
        async with self._slots:
            if tally.started is None:
                tally.started = time.monotonic()
            tally.attempts += 1
            return await self._send(method, url, timeout, connect.timeout_s, content)

    async def _send(
        self, method: str, url: str, timeout: float, connect_timeout: float, content: dict[str, Any]
    ) -> httpx.Response:
        assert self._client is not None, "Outbound must be used as a context manager"
        return await self._client.request(
            method, url, timeout=httpx.Timeout(timeout, connect=connect_timeout), **content
        )


def _decode(response: httpx.Response) -> Any:
    """The parsed JSON of an answer below 500, or the neutral error for its status."""
    status = response.status_code
    if status in RATE_LIMIT_STATUSES:
        # Only a 429 is a rate limit that passes; 401 and 403 are credentials and never do.
        raise ProviderRateLimited(_retry_after_s(response) if status == 429 else None)
    try:
        body = response.json()
    except ValueError:
        body = None
    if status == 400:
        raise UpstreamBadRequest(body)
    if status >= 400:
        raise ProviderUnavailable
    if body is None:
        raise MalformedResponse
    return body


def _retry_after_s(response: httpx.Response) -> float | None:
    """The `Retry-After` header as seconds; absent, a date or anything else unusable is None."""
    try:
        seconds = float(response.headers["Retry-After"])
    except (KeyError, ValueError):
        return None
    return seconds if math.isfinite(seconds) and seconds >= 0 else None
