"""A bounded store of forecast series by forecast cell.

A series is used only while its first stamp is the request's current UTC hour, so a cached
entry is keyed by the cell and its own `start`: a later hour's series replaces it and every
older entry is dropped. Not thread-safe: the owner touches it only on the event loop.
"""

from datetime import datetime

from .lattice import Cell
from .series import ForecastSeries


class ForecastCache:
    def __init__(self, max_entries: int) -> None:
        if max_entries < 1:
            raise ValueError("the cache needs room for at least one entry")
        self._max_entries = max_entries
        self._entries: dict[Cell, ForecastSeries] = {}
        self._newest: datetime | None = None

    def __len__(self) -> int:
        return len(self._entries)

    def get(self, cell: Cell, hour: datetime) -> ForecastSeries | None:
        """The cell's series if it starts at `hour`, the UTC hour the caller is working in."""
        series = self._entries.get(cell)
        return series if series is not None and series.start == hour else None

    def put(self, cell: Cell, series: ForecastSeries) -> None:
        """Keep the series, dropping every entry from an earlier hour and, past the ceiling, the
        entries stored longest ago. A series older than one already held is not kept."""
        if self._newest is None or series.start > self._newest:
            self._newest = series.start
            self._entries = {c: s for c, s in self._entries.items() if s.start == series.start}
        elif series.start < self._newest:
            return
        self._entries.pop(cell, None)
        self._entries[cell] = series
        while len(self._entries) > self._max_entries:
            del self._entries[next(iter(self._entries))]

    def clear(self) -> None:
        self._entries = {}
        self._newest = None
