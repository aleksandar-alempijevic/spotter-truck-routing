"""The API object and its endpoints."""

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from ninja import NinjaAPI, Schema
from ninja.errors import ValidationError

from providers import (
    MalformedResponse,
    NoRouteFound,
    ProviderError,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)

from .planner import plan_routes
from .schemas import ErrorOut, RoutesIn, RoutesOut

api = NinjaAPI(title="Spotter truck routing API", version="0.1.0")

ERROR_STATUS: dict[type[ProviderError], int] = {
    NoRouteFound: 422,
    ProviderTimeout: 504,
    ProviderUnavailable: 502,
    MalformedResponse: 502,
    ProviderRateLimited: 503,
    ProviderNotConfigured: 503,
}
ERROR_RESPONSES = {422: ErrorOut, 502: ErrorOut, 503: ErrorOut, 504: ErrorOut}


@api.exception_handler(ValidationError)
def validation_error(request: HttpRequest, exc: ValidationError) -> HttpResponse:
    details = "; ".join(
        f"{'.'.join(str(part) for part in error['loc'] if part != 'body')}: {error['msg']}"
        for error in exc.errors
    )
    return api.create_response(
        request, {"code": "validation_error", "message": details}, status=422
    )


@api.exception_handler(ProviderError)
def provider_error(request: HttpRequest, exc: ProviderError) -> HttpResponse:
    status = ERROR_STATUS.get(type(exc), 502)
    return api.create_response(request, {"code": exc.code, "message": exc.message}, status=status)


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
async def routes(request: HttpRequest, payload: RoutesIn) -> RoutesOut:
    plan = await plan_routes(
        settings.TOMTOM_API_KEY,
        origin=(payload.origin.lat, payload.origin.lon),
        destination=(payload.destination.lat, payload.destination.lon),
        departure=payload.departure,
        load_lb=payload.load_lb,
        spacing_miles=payload.checkpoint_interval_miles,
    )
    return RoutesOut.model_validate(
        {
            "load_lb": payload.load_lb,
            "checkpoint_interval_miles": payload.checkpoint_interval_miles,
            "routes": [
                {
                    "id": planned.id,
                    "travel_time_seconds": round(planned.route.travel_time_s),
                    "total_miles": planned.route.total_miles,
                    "checkpoints": [
                        {"mile": c.mile, "lat": c.lat, "lon": c.lon, "eta": c.eta}
                        for c in planned.checkpoints
                    ],
                    "line": [[lon, lat] for lat, lon in planned.line],
                    "source": planned.route.source,
                    "via": (
                        {"name": v.name, "lat": v.lat, "lon": v.lon}
                        if (v := planned.route.via)
                        else None
                    ),
                }
                for planned in plan.routes
            ],
            "shortfall": (
                {"reason": plan.shortfall.reason, "message": plan.shortfall.message}
                if plan.shortfall
                else None
            ),
        }
    )
