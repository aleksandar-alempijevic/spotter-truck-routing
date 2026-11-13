"""Geoapify address autocomplete: the only module that knows Geoapify's URL and field names."""

from dataclasses import dataclass
from typing import Any

from .errors import MalformedResponse, ProviderNotConfigured, ProviderUnavailable
from .outbound import Outbound, UpstreamBadRequest

AUTOCOMPLETE_URL = "https://api.geoapify.com/v1/geocode/autocomplete"
CALL_TIMEOUT_S = 5.0
NUMBER_FIRST_TIMEOUT_S = 10.0
"""A search that starts with a house number and names no place is slow (7 to 9 s measured), and no
filter or type speeds it up, so it gets a longer deadline."""
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
    """US places matching the typed text.

    Text with no digit is a city or a place name, so it is searched as `type=city` first, which
    keeps "Salt Lake" from answering with a town in New Mexico; if that finds nothing, one more
    search runs without a type, so a depot name stays findable. Text with a digit keeps the
    untyped search, since it can be an address, and one that starts with a number gets the longer
    deadline.

    A suggestion without a label, coordinates or time zone is dropped, because the UI could not
    place it or convert a departure time for it. An empty list is a normal answer. A call is
    not retried: a keystroke's answer is stale by the time a retry would arrive.
    """
    if not api_key:
        raise ProviderNotConfigured
    if any(char.isdigit() for char in text):
        timeout = NUMBER_FIRST_TIMEOUT_S if text.lstrip()[:1].isdigit() else CALL_TIMEOUT_S
        return await _search(outbound, api_key, text, place_type=None, timeout=timeout)
    cities = await _search(outbound, api_key, text, place_type="city", timeout=CALL_TIMEOUT_S)
    if cities:
        return cities
    return await _search(outbound, api_key, text, place_type=None, timeout=CALL_TIMEOUT_S)


async def _search(
    outbound: Outbound, api_key: str, text: str, *, place_type: str | None, timeout: float
) -> list[PlaceSuggestion]:
    params: dict[str, Any] = {
        "text": text,
        "apiKey": api_key,
        "format": "json",
        "limit": SUGGESTION_LIMIT,
        "filter": "countrycode:us",
    }
    if place_type:
        params["type"] = place_type
    try:
        body = await outbound.get_json(AUTOCOMPLETE_URL, params, timeout=timeout, retry=False)
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
