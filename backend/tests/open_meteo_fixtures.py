"""One Open-Meteo forecast-location body, shared by the adapter and endpoint tests."""

STAMPS = ["2026-11-13T14:00", "2026-11-13T15:00", "2026-11-13T16:00"]
UNITS = {
    "time": "iso8601",
    "wind_speed_10m": "mp/h",
    "wind_gusts_10m": "mp/h",
    "precipitation": "inch",
    "snowfall": "inch",
}
_DEFAULT_COLUMNS = {
    "wind_speed_10m": [10.0, 20.0, 30.0],
    "wind_gusts_10m": [15.0, 25.0, 35.0],
    "precipitation": [0.0, 0.5, 0.0],
    "snowfall": [0.0, 0.7, 0.0],
}


def location(stamps=STAMPS, *, hourly=None, hourly_units=None, **extra) -> dict:
    """A location answer with a series per field: the given `hourly` columns, and a repeating
    default for those left out. `hourly` and `hourly_units` override fields; `extra` adds keys."""
    columns = {
        field: [values[i % 3] for i in range(len(stamps))]
        for field, values in _DEFAULT_COLUMNS.items()
    }
    return {
        "latitude": 39.7,
        "longitude": -105.0,
        "hourly_units": {**UNITS, **(hourly_units or {})},
        "hourly": {"time": stamps, **columns, **(hourly or {})},
        **extra,
    }
