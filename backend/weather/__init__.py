"""Forecast series, sampling at an instant, and the corridor grid with its location plan.

Pure computation on provider-neutral types: standard library and `routing` only, and independent
of `risk_rules`. The providers return this package's `ForecastSeries`; the API layer turns
`Conditions` into risk readings. The package exports what the other packages use; the rest is
reached through its modules.
"""

from .cache import ForecastCache
from .grid import GridCell, LocationPlan, TooManyLocations, plan_locations
from .lattice import Cell, cell_center, forecast_cell
from .series import Conditions, ForecastSeries, conditions_at, conditions_by_hour, utc_hour

__all__ = [
    "Cell",
    "Conditions",
    "ForecastCache",
    "ForecastSeries",
    "GridCell",
    "LocationPlan",
    "TooManyLocations",
    "cell_center",
    "conditions_at",
    "conditions_by_hour",
    "forecast_cell",
    "plan_locations",
    "utc_hour",
]
