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

CONNECT_TIMEOUT_S = 3.0
CONNECT_ATTEMPTS = 4
"""A connection that cannot be opened is tried again at once, up to this many tries of
`CONNECT_TIMEOUT_S` each: a call that never connects gives up after 12 s. These tries are separate
from the one retry of a timeout, transport error or 5xx, which a call that never connected does
not get, so the two do not multiply."""

RETRY_STATUSES = range(500, 600)
RATE_LIMIT_STATUSES = {401, 403, 429}


class UpstreamBadRequest(Exception):
    """A provider answered 400. The adapter reads `body` and turns this into a neutral error.

    Never let this reach a response or a log: the body is the provider's own text.
    """

    def __init__(self, body: Any) -> None:
        super().__init__("provider answered 400")
        self.body = body


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
    ) -> Any:
        """GET a URL and return its parsed JSON.

        Retries once on a timeout, a transport error or a 5xx, never on a 4xx; a connection that
        cannot be opened is tried up to `CONNECT_ATTEMPTS` times in place of that retry. Raises the
        neutral errors from `providers.errors`. A 400 raises `UpstreamBadRequest` so the adapter
        can tell its provider's cases apart.
        """
        return await self._call("GET", url, timeout, retry, params=params)

    async def post_form(
        self,
        url: str,
        data: dict[str, Any],
        *,
        timeout: float,
        headers: dict[str, str] | None = None,
    ) -> Any:
        """POST a form-encoded body and return the parsed JSON, under the same policy as
        `get_json`, with its retry. Used where a request would not fit in a URL."""
        return await self._call("POST", url, timeout, True, data=data, headers=headers)

    async def _call(
        self, method: str, url: str, timeout: float, retry: bool, **content: Any
    ) -> Any:
        started = time.monotonic()
        attempts = 0
        retries_left = 1 if retry else 0
        connects_left = CONNECT_ATTEMPTS
        while True:
            attempts += 1
            try:
                async with self._slots:
                    response = await self._send(method, url, timeout, content)
            except (httpx.ConnectTimeout, httpx.ConnectError) as error:
                timed_out = isinstance(error, httpx.ConnectTimeout)
                failure = ProviderTimeout if timed_out else ProviderUnavailable
                kind = type(error).__name__
                connects_left -= 1
                if connects_left:
                    continue
                break  # never connected: the connect tries were the retry
            except httpx.TimeoutException as error:
                failure = ProviderTimeout
                kind = type(error).__name__
            except httpx.HTTPError:
                failure = ProviderUnavailable
            else:
                if response.status_code not in RETRY_STATUSES:
                    return _decode(response)
                failure = ProviderUnavailable
            if not retries_left:
                break
            retries_left -= 1
            connects_left = CONNECT_ATTEMPTS
        if failure is ProviderTimeout:
            # The host only: the URL's query carries the key, and the path its coordinates.
            logger.warning(
                "provider call timed out: host=%s, kind=%s, attempts=%d, elapsed=%.1f s",
                urlsplit(url).hostname,
                kind,
                attempts,
                time.monotonic() - started,
            )
        raise failure from None

    async def _send(
        self, method: str, url: str, timeout: float, content: dict[str, Any]
    ) -> httpx.Response:
        assert self._client is not None, "Outbound must be used as a context manager"
        return await self._client.request(
            method, url, timeout=httpx.Timeout(timeout, connect=CONNECT_TIMEOUT_S), **content
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
