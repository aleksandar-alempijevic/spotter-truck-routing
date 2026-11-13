"""The API object and its endpoints."""

import logging
from typing import Annotated

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse
from ninja import NinjaAPI, Query, Schema
from ninja.errors import HttpError, ValidationError
from pydantic import StringConstraints

from providers import (
    ATTRIBUTION_TEXT,
    ATTRIBUTION_URL,
    Outbound,
    ProviderError,
    autocomplete,
)
from providers.errors import error_classes

from .errors import API_ERRORS, VALIDATION_ERROR_CODES
from .planner import plan_routes
from .schemas import (
    AddressSearchOut,
    ErrorCode,
    ErrorOut,
    RoutesIn,
    RoutesOut,
    WeatherIn,
    WeatherOut,
)
from .weather_report import build_report, default_runtime

api = NinjaAPI(title="Spotter truck routing API", version="0.1.0")

logger = logging.getLogger(__name__)

ERROR_RESPONSES = dict.fromkeys(
    {422, *API_ERRORS, *(error.status for error in error_classes())},
    ErrorOut,
)
"""The error statuses every endpoint declares: the validation and general API errors, and the
status of every provider error class."""


def error_response(request: HttpRequest, code: ErrorCode, message: str, status: int):
    return api.create_response(request, {"code": code, "message": message}, status=status)


@api.exception_handler(ValidationError)
def validation_error(request: HttpRequest, exc: ValidationError) -> HttpResponse:
    def field(error: dict) -> str:
        return ".".join(str(part) for part in error["loc"] if part not in ("body", "query"))

    details = "; ".join(f"{field(error)}: {error['msg']}" for error in exc.errors)
    code = next(
        (
            VALIDATION_ERROR_CODES[error["type"]]
            for error in exc.errors
            if error.get("type") in VALIDATION_ERROR_CODES
        ),
        "validation_error",
    )
    return error_response(request, code, details, 422)


@api.exception_handler(RequestDataTooBig)
def body_too_big(request: HttpRequest, exc: RequestDataTooBig) -> HttpResponse:
    """A body over Django's upload limit is the client's fault, not a server error."""
    return error_response(request, "validation_error", "The request body is too large.", 422)


@api.exception_handler(HttpError)
def http_error(request: HttpRequest, exc: HttpError) -> HttpResponse:
    """Ninja raises a 400 `HttpError` for a body it cannot parse as JSON."""
    if exc.status_code == 400:
        return error_response(
            request, "validation_error", "The request body is not valid JSON.", 422
        )
    return unexpected_error(request, exc)


@api.exception_handler(ProviderError)
def provider_error(request: HttpRequest, exc: ProviderError) -> HttpResponse:
    return error_response(request, exc.code, exc.message, exc.status)


@api.exception_handler(Exception)
def unexpected_error(request: HttpRequest, exc: Exception) -> HttpResponse:
    """Anything else is a bug: log it, and answer with no detail from it."""
    logger.error("unhandled error in %s", request.path, exc_info=exc)
    code, message, status = API_ERRORS[500]
    return error_response(request, code, message, status)


class HealthOut(Schema):
    status: str


@api.get("/health", response={200: HealthOut, **ERROR_RESPONSES}, summary="Liveness check")
async def health(request) -> dict:
    return {"status": "ok"}


@api.post(
    "/routes",
    response={200: RoutesOut, **ERROR_RESPONSES},
    summary="Up to three truck routes with checkpoints and ETAs",
)
async def routes(request: HttpRequest, payload: RoutesIn):
    plan = await plan_routes(
        settings.TOMTOM_API_KEY,
        origin=(payload.origin.lat, payload.origin.lon),
        destination=(payload.destination.lat, payload.destination.lon),
        departure=payload.departure,
        load_lb=payload.load_lb,
        spacing_miles=payload.checkpoint_interval_miles,
    )
    return {
        "load_lb": payload.load_lb,
        "checkpoint_interval_miles": payload.checkpoint_interval_miles,
        "routes": plan.routes,
        "shortfall": plan.shortfall,
    }


WEATHER_RUNTIME = default_runtime()
"""The clock, sleep and forecast cache the weather endpoint uses: one per process, so every
request shares the cache."""


@api.post(
    "/weather",
    response={200: WeatherOut, **ERROR_RESPONSES},
    summary="Forecast weather, risk levels and a ranking for routes, plus the corridor heatmap",
)
async def weather(request: HttpRequest, payload: WeatherIn):
    return await build_report(
        payload.routes,
        load_lb=payload.load_lb,
        spacing_miles=payload.checkpoint_interval_miles,
        runtime=WEATHER_RUNTIME,
    )


SEARCH_MIN_CHARS = 3
SEARCH_MAX_CHARS = 100
SearchText = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=SEARCH_MIN_CHARS, max_length=SEARCH_MAX_CHARS
    ),
]


@api.get(
    "/address-search",
    response={200: AddressSearchOut, **ERROR_RESPONSES},
    summary="US place suggestions for typed text",
)
async def address_search(request: HttpRequest, q: Query[SearchText]):
    async with Outbound() as outbound:
        suggestions = await autocomplete(outbound, settings.GEOAPIFY_API_KEY, q)
    return {
        "suggestions": suggestions,
        "attribution": {"text": ATTRIBUTION_TEXT, "url": ATTRIBUTION_URL},
    }
