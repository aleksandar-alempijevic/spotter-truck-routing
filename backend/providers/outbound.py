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

CONNECT_TIMEOUT_S = 10.0
"""The default connect timeout. A caller whose host has shown connect failures passes a shorter one
and more tries."""

CONNECT_ERROR_PAUSES_S = (0.25, 0.5, 0.5)
"""The pause before each further connect try after a refused connection or a failed name lookup.
A connect timeout needs none: the timeout already spaced its tries."""

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


async def _pause(seconds: float) -> None:
    await asyncio.sleep(seconds)


class Outbound:
    """An async context manager owning one HTTP client and its concurrency cap.

    Open it inside the request's coroutine so the client is closed on every exit path, including
    the cancellation Django's ASGI handler applies when the browser disconnects. Calls wait on a
    semaphore, so a waiter can queue behind a slow call without a pool timeout cutting it off.
    """

    def __init__(self, max_concurrent: int = MAX_CONCURRENT_CALLS) -> None:
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
        connect_timeout: float = CONNECT_TIMEOUT_S,
        connect_attempts: int = 1,
    ) -> Any:
        """GET a URL and return its parsed JSON.

        Retries once on a timeout, a transport error or a 5xx, never on a 4xx. A connection that
        cannot be opened is tried `connect_attempts` times (one by default), each with
        `connect_timeout`; with more than one, a call that never connects is not retried again,
        so the tries do not multiply with the retry. Raises the
        neutral errors from `providers.errors`. A 400 raises `UpstreamBadRequest` so the adapter
        can tell its provider's cases apart.
        """
        return await self._call(
            "GET", url, timeout, retry, (connect_timeout, connect_attempts), params=params
        )

    async def post_form(
        self,
        url: str,
        data: dict[str, Any],
        *,
        timeout: float,
        headers: dict[str, str] | None = None,
        connect_timeout: float = CONNECT_TIMEOUT_S,
        connect_attempts: int = 1,
    ) -> Any:
        """POST a form-encoded body and return the parsed JSON, under the same policy as
        `get_json`, with its retry. Used where a request would not fit in a URL."""
        return await self._call(
            "POST",
            url,
            timeout,
            True,
            (connect_timeout, connect_attempts),
            data=data,
            headers=headers,
        )

    async def _call(
        self,
        method: str,
        url: str,
        timeout: float,
        retry: bool,
        connect: tuple[float, int],
        **content: Any,
    ) -> Any:
        tally = _Tally()
        retries_left = 1 if retry else 0
        while True:
            try:
                response = await self._send_connecting(
                    method, url, timeout, connect, content, tally
                )
            except (httpx.ConnectTimeout, httpx.ConnectError) as error:
                failure = (
                    ProviderTimeout
                    if isinstance(error, httpx.TimeoutException)
                    else ProviderUnavailable
                )
                kind = type(error).__name__
                if connect[1] > 1:
                    break  # the connect tries were the retry
            except httpx.TimeoutException as error:
                failure = ProviderTimeout
                kind = type(error).__name__
            except httpx.HTTPError:
                failure = ProviderUnavailable
                kind = None
            else:
                if response.status_code not in RETRY_STATUSES:
                    return _decode(response)
                failure = ProviderUnavailable
                kind = None
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
        connect: tuple[float, int],
        content: dict[str, Any],
        tally: _Tally,
    ) -> httpx.Response:
        """One try's request, with up to `connect[1]` tries to open its connection; the last
        connect error is raised. Each try takes its own slot, so the clock in `tally` starts
        when the call first runs, not while it queues."""
        connect_timeout, connect_attempts = connect
        for attempt in range(connect_attempts):
            try:
                async with self._slots:
                    if tally.started is None:
                        tally.started = time.monotonic()
                    tally.attempts += 1
                    return await self._send(method, url, timeout, connect_timeout, content)
            except httpx.ConnectTimeout:
                if attempt == connect_attempts - 1:
                    raise
            except httpx.ConnectError:
                if attempt == connect_attempts - 1:
                    raise
                await _pause(CONNECT_ERROR_PAUSES_S[attempt])
        raise AssertionError("connect_attempts must be at least 1")

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
