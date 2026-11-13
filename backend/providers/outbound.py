"""Shared outbound HTTP policy: one client per planning request, a concurrency cap, a timeout
and one retry, for GET and for form-encoded POST.

The providers carry their keys in the query string, and httpx logs the full URL of every request
at INFO level and puts it in its exception text. Every httpx failure is therefore turned into a
provider-neutral error without a URL or upstream body, and the project's `LOGGING` setting
(`config/base.py`) keeps the `httpx` and `httpcore` loggers at WARNING.
"""

import asyncio
import math
from types import TracebackType
from typing import Any, Self

import httpx

from .errors import (
    MalformedResponse,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)

MAX_CONCURRENT_CALLS = 4
"""Calls in flight at once within one planning request; further calls wait their turn."""

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

        Retries once on a timeout, a transport error or a 5xx, never on a 4xx. Raises the
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
        retry: bool = True,
        headers: dict[str, str] | None = None,
    ) -> Any:
        """POST a form-encoded body and return the parsed JSON, under the same policy as
        `get_json`. Used where a request would not fit in a URL."""
        return await self._call("POST", url, timeout, retry, data=data, headers=headers)

    async def _call(
        self, method: str, url: str, timeout: float, retry: bool, **content: Any
    ) -> Any:
        for _ in range(2 if retry else 1):
            try:
                async with self._slots:
                    response = await self._send(method, url, timeout, content)
            except httpx.TimeoutException:
                failure = ProviderTimeout
            except httpx.HTTPError:
                failure = ProviderUnavailable
            else:
                if response.status_code not in RETRY_STATUSES:
                    return _decode(response)
                failure = ProviderUnavailable
        raise failure from None

    async def _send(
        self, method: str, url: str, timeout: float, content: dict[str, Any]
    ) -> httpx.Response:
        assert self._client is not None, "Outbound must be used as a context manager"
        return await self._client.request(
            method, url, timeout=httpx.Timeout(timeout, connect=10), **content
        )


def _decode(response: httpx.Response) -> Any:
    """The parsed JSON of an answer below 500, or the neutral error for its status."""
    status = response.status_code
    if status in RATE_LIMIT_STATUSES:
        raise ProviderRateLimited(_retry_after_s(response))
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
