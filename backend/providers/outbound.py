"""Shared outbound HTTP policy: one client per planning request, a concurrency cap, a timeout
and one retry.

The providers carry their keys in the query string, and httpx logs the full URL of every request
at INFO level and puts it in its exception text. So the `httpx` logger is silenced here, and every
httpx failure is turned into a provider-neutral error without a URL or upstream body.
"""

import asyncio
import logging
from types import TracebackType
from typing import Any, Self

import httpx

from .errors import (
    MalformedResponse,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)

logging.getLogger("httpx").setLevel(logging.WARNING)

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
        self._max_concurrent = max_concurrent
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
        attempts = 2 if retry else 1
        for attempt in range(attempts):
            last = attempt == attempts - 1
            try:
                async with self._slots:
                    response = await self._send(url, params, timeout)
            except httpx.TimeoutException:
                if last:
                    raise ProviderTimeout from None
                continue
            except httpx.HTTPError:
                if last:
                    raise ProviderUnavailable from None
                continue
            status = response.status_code
            if status in RETRY_STATUSES:
                if last:
                    raise ProviderUnavailable
                continue
            if status in RATE_LIMIT_STATUSES:
                raise ProviderRateLimited
            if status == 400:
                raise UpstreamBadRequest(_json_or_none(response))
            if status >= 400:
                raise ProviderUnavailable
            try:
                return response.json()
            except ValueError:
                raise MalformedResponse from None
        raise AssertionError("unreachable")  # pragma: no cover

    async def _send(self, url: str, params: dict[str, Any], timeout: float) -> httpx.Response:
        assert self._client is not None, "Outbound must be used as a context manager"
        return await self._client.get(
            url, params=params, timeout=httpx.Timeout(timeout, connect=10)
        )


def _json_or_none(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None
