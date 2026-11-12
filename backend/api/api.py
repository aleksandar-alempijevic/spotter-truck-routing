"""The API object and its endpoints."""

from typing import Annotated

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from ninja import NinjaAPI, Query, Schema
from ninja.errors import ValidationError
from pydantic import StringConstraints

from providers import (
    ATTRIBUTION_TEXT,
    ATTRIBUTION_URL,
    Outbound,
    ProviderError,
    autocomplete,
)

from .planner import plan_routes
from .schemas import AddressSearchOut, ErrorOut, RoutesIn, RoutesOut

api = NinjaAPI(title="Spotter truck routing API", version="0.1.0")

ERROR_RESPONSES = dict.fromkeys(
    {422, ProviderError.status, *(error.status for error in ProviderError.__subclasses__())},
    ErrorOut,
)
"""The error statuses every endpoint declares, taken from the provider error classes."""


@api.exception_handler(ValidationError)
def validation_error(request: HttpRequest, exc: ValidationError) -> HttpResponse:
    def field(error: dict) -> str:
        return ".".join(str(part) for part in error["loc"] if part not in ("body", "query"))

    details = "; ".join(f"{field(error)}: {error['msg']}" for error in exc.errors)
    return api.create_response(
        request, {"code": "validation_error", "message": details}, status=422
    )


@api.exception_handler(ProviderError)
def provider_error(request: HttpRequest, exc: ProviderError) -> HttpResponse:
    return api.create_response(
        request, {"code": exc.code, "message": exc.message}, status=exc.status
    )


class HealthOut(Schema):
    status: str


@api.get("/health", response=HealthOut, summary="Liveness check")
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
