"""Answer `{code, message}` for the responses Django and Ninja produce before any handler runs.

An unknown `/api/` path (Django's 404 page) and a wrong HTTP method (Ninja's plain-text 405) never
reach an exception handler, so this middleware rewrites them. Everything else under `/api/` is
answered by the handlers in `api.py`; paths outside `/api/` are left alone.
"""

from asgiref.sync import iscoroutinefunction, markcoroutinefunction
from django.http import HttpRequest, HttpResponse, JsonResponse

from .errors import API_ERRORS


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
        is_json = response.headers.get("Content-Type", "").startswith("application/json")
        if request.path.startswith("/api/") and response.status_code in (404, 405) and not is_json:
            code, message, status = API_ERRORS[response.status_code]
            return JsonResponse({"code": code, "message": message}, status=status)
        return response
