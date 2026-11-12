"""The API object and its endpoints."""

from ninja import NinjaAPI, Schema

api = NinjaAPI(title="Spotter truck routing API", version="0.1.0")


class HealthOut(Schema):
    status: str


@api.get("/health", response=HealthOut, summary="Liveness check")
async def health(request) -> dict:
    return {"status": "ok"}
