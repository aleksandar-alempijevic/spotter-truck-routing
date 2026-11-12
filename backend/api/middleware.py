"""Answer `{code, message}` for every error response under `/api/` that does not already have it.

An unknown path (Django's 404 page), a wrong HTTP method (Ninja's plain-text 405) and Ninja's own
pre-registered handlers (a `Http404` answers `{"detail": ...}`) do not produce the API's error
body. This middleware judges the body, not the layer that produced it: any error status under
`/api/` whose body is not a JSON object with exactly `code` and `message` is replaced. Paths
outside `/api/` are left alone.
"""

import json
import logging

from asgiref.sync import iscoroutinefunction, markcoroutinefunction
from django.http import HttpRequest, HttpResponse, JsonResponse

from .errors import API_ERRORS

logger = logging.getLogger(__name__)


def has_error_body(response: HttpResponse) -> bool:
    if response.streaming:
        return False
    try:
        body = json.loads(response.content)
    except ValueError:
        return False
    return (
        isinstance(body, dict)
        and body.keys() == {"code", "message"}
        and all(isinstance(value, str) for value in body.values())
    )


class ApiErrorBodies:
    sync_capable = True
    async_capable = True

    def __init__(self, get_response):
        self.get_response = get_response
        if iscoroutinefunction(get_response):
            markcoroutinefunction(self)

    def __call__(self, request: HttpRequest):
        if iscoroutinefunction(self.get_response):
            return self._acall(request)
        return self._rewrite(request, self.get_response(request))

    async def _acall(self, request: HttpRequest) -> HttpResponse:
        return self._rewrite(request, await self.get_response(request))

    @staticmethod
    def _rewrite(request: HttpRequest, response: HttpResponse) -> HttpResponse:
        if (
            not request.path.startswith("/api/")
            or response.status_code < 400
            or has_error_body(response)
        ):
            return response
        # Only a 404 and a 405 are expected here; any other status without the body is a gap.
        if response.status_code not in (404, 405):
            logger.warning("API answered %s without an error body", response.status_code)
        code, message, status = API_ERRORS.get(response.status_code, API_ERRORS[500])
        rewritten = JsonResponse({"code": code, "message": message}, status=status)
        if allow := response.headers.get("Allow"):
            rewritten["Allow"] = allow
        return rewritten
