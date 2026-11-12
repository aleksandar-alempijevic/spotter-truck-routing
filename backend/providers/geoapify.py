"""Geoapify address autocomplete: the only module that knows Geoapify's URL and field names."""

from dataclasses import dataclass
from typing import Any

from .errors import MalformedResponse, ProviderNotConfigured, ProviderUnavailable
from .outbound import Outbound, UpstreamBadRequest

AUTOCOMPLETE_URL = "https://api.geoapify.com/v1/geocode/autocomplete"
CALL_TIMEOUT_S = 5.0
SUGGESTION_LIMIT = 5

ATTRIBUTION_TEXT = "Powered by Geoapify"
ATTRIBUTION_URL = "https://www.geoapify.com/"
"""What Geoapify's free plan requires to be shown next to its results."""


@dataclass(frozen=True, slots=True)
class PlaceSuggestion:
    label: str
    """The full text of the place, including its state."""
    lat: float
    lon: float
    timezone: str
    """IANA name, for example America/Chicago."""


async def autocomplete(outbound: Outbound, api_key: str, text: str) -> list[PlaceSuggestion]:
    """US places matching the typed text, of any type (address, street, city).

    A suggestion without a label, coordinates or time zone is dropped, because the UI could not
    place it or convert a departure time for it. An empty list is a normal answer. The call is
    not retried: a keystroke's answer is stale by the time a retry would arrive.
    """
    if not api_key:
        raise ProviderNotConfigured
    params = {
        "text": text,
        "apiKey": api_key,
        "format": "json",
        "limit": SUGGESTION_LIMIT,
        "filter": "countrycode:us",
    }
    try:
        body = await outbound.get_json(
            AUTOCOMPLETE_URL, params, timeout=CALL_TIMEOUT_S, retry=False
        )
    except UpstreamBadRequest:
        raise ProviderUnavailable from None
    if not isinstance(body, dict) or not isinstance(body.get("results"), list):
        raise MalformedResponse
    suggestions = (_parse(result) for result in body["results"])
    return [suggestion for suggestion in suggestions if suggestion]


def _parse(result: Any) -> PlaceSuggestion | None:
    if not isinstance(result, dict):
        return None
    label, lat, lon = result.get("formatted"), result.get("lat"), result.get("lon")
    timezone = result.get("timezone")
    if isinstance(timezone, dict):
        timezone = timezone.get("name")
    numbers = all(isinstance(v, int | float) and not isinstance(v, bool) for v in (lat, lon))
    if not (
        isinstance(label, str) and label and numbers and isinstance(timezone, str) and timezone
    ):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return PlaceSuggestion(label, float(lat), float(lon), timezone)
