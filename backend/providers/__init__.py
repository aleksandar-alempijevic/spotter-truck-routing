"""Outbound HTTP to the data providers.

The only package that imports `httpx`, knows a provider's URL or field names, or touches an API
key. It returns `routing`'s types and raises the neutral errors in `errors`.
"""

from .errors import (
    MalformedResponse,
    NoRouteFound,
    ProviderError,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)
from .geoapify import ATTRIBUTION_TEXT, ATTRIBUTION_URL, PlaceSuggestion, autocomplete
from .outbound import MAX_CONCURRENT_CALLS, Outbound
from .tomtom import calculate_routes

__all__ = [
    "ATTRIBUTION_TEXT",
    "ATTRIBUTION_URL",
    "MAX_CONCURRENT_CALLS",
    "MalformedResponse",
    "NoRouteFound",
    "PlaceSuggestion",
    "Outbound",
    "ProviderError",
    "ProviderNotConfigured",
    "ProviderRateLimited",
    "ProviderTimeout",
    "ProviderUnavailable",
    "autocomplete",
    "calculate_routes",
]
