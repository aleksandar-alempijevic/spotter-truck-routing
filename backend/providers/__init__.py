"""Outbound HTTP to the data providers.

The only package that imports `httpx`, knows a provider's URL or field names, or touches an API
key. It returns `routing`'s types and raises the neutral errors in `errors`. The package exports
what the API layer uses; the rest is reached through its modules.
"""

from .errors import NoRouteFound, ProviderError, ProviderTimeout
from .geoapify import ATTRIBUTION_TEXT, ATTRIBUTION_URL, autocomplete
from .openmeteo import MAX_LOCATIONS_PER_CALL, fetch_forecasts
from .outbound import Outbound
from .tomtom import calculate_routes

__all__ = [
    "MAX_LOCATIONS_PER_CALL",
    "ATTRIBUTION_TEXT",
    "ATTRIBUTION_URL",
    "NoRouteFound",
    "Outbound",
    "ProviderError",
    "ProviderTimeout",
    "autocomplete",
    "calculate_routes",
    "fetch_forecasts",
]
