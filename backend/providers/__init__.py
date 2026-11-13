"""Outbound HTTP to the data providers.

The only package that imports `httpx`, knows a provider's URL or field names, or touches an API
key. It returns `routing`'s and `weather`'s types and raises the neutral errors in `errors`. The
package exports what the API layer uses from the Geoapify and TomTom adapters. The Open-Meteo
adapter is reached through its module (`providers.openmeteo`), because its caller needs many of
its names (the two halves of a call, their raw type, the limits) and its attribution constants
share names with Geoapify's, so a package-level export would be ambiguous.
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
