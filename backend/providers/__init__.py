"""Outbound HTTP to the data providers.

The only package that imports `httpx`, knows a provider's URL or field names, or touches an API
key. It returns `routing`'s and `weather`'s types and raises the neutral errors in `errors`. The
package exports what the API layer uses from the keyed adapters; the Open-Meteo adapter is
reached through its module (`providers.openmeteo`), like anything else not listed here.
"""

from .errors import NoRouteFound, ProviderError, ProviderTimeout
from .geoapify import ATTRIBUTION_TEXT, ATTRIBUTION_URL, autocomplete
from .outbound import Outbound
from .tomtom import calculate_routes

__all__ = [
    "ATTRIBUTION_TEXT",
    "ATTRIBUTION_URL",
    "NoRouteFound",
    "Outbound",
    "ProviderError",
    "ProviderTimeout",
    "autocomplete",
    "calculate_routes",
]
