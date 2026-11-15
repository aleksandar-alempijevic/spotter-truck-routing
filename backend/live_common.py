"""What the live-check scripts share: Django set-up with the app's own settings, a guard on the
number of provider calls, a record of each call, and the output file.

Not part of `make check` or pytest: the scripts that use it spend real provider calls. Nothing
here prints or records a key or a request URL. `record_calls` guards the number of GET calls (the
keyed providers); `LocationMeter` guards the number of Open-Meteo locations, which is what its
quota counts.
"""

import json
import os
import time
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from providers.openmeteo import MAX_LOCATIONS_PER_CALL
from providers.outbound import Outbound, UpstreamBadRequest
from weather import Cell, LocationPlan


def start_django() -> None:
    """Configure Django from `config.settings` (which loads the repository's `.env`)."""
    os.environ.setdefault("DJANGO_DEBUG", "1")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django
    from django.test.utils import setup_test_environment

    django.setup()
    setup_test_environment()


class Budget:
    """A limit on units of provider use, and the records of the calls made against it."""

    def __init__(self, limit: int, unit: str) -> None:
        self.limit, self.unit, self.spent = limit, unit, 0
        self.records: list[dict[str, Any]] = []

    async def run(
        self,
        units: int,
        record: dict[str, Any],
        call: Callable[[], Awaitable[Any]],
        on_error: Callable[[dict[str, Any], Exception], None] | None = None,
    ) -> Any:
        """Make the call, or refuse it (before anything is sent) when it would pass the limit.

        The record is kept, and gets `seconds`; a failure is noted on it by `on_error` (by default
        the error's class name under `outcome`) and raised again.
        """
        if self.spent + units > self.limit:
            raise RuntimeError(f"provider {self.unit} budget reached")
        self.spent += units
        self.records.append(record)
        started = time.monotonic()
        try:
            return await call()
        except Exception as error:
            (on_error or _note_error)(record, error)
            raise
        finally:
            record["seconds"] = round(time.monotonic() - started, 2)


def _note_error(record: dict[str, Any], error: Exception) -> None:
    record["outcome"] = type(error).__name__


def record_calls(
    max_calls: int,
    label: Callable[[str], dict[str, Any]] = lambda url: {},
    describe: Callable[[Any], dict[str, Any]] = lambda body: {},
) -> list[dict[str, Any]]:
    """Wrap `Outbound.get_json` for the rest of the process so every call is recorded and the
    budget is enforced.

    Each record has `outcome` ("ok", "400 <code>" or the error's class name), `seconds`, whatever
    `label(url)` returns for the call (called before it is made, and must not keep the URL) and,
    for a successful call, whatever `describe(body)` returns. Returns the list the records are
    appended to.
    """
    budget = Budget(max_calls, "call")
    real_get_json = Outbound.get_json

    def note_error(record: dict[str, Any], error: Exception) -> None:
        if not isinstance(error, UpstreamBadRequest):
            return _note_error(record, error)
        try:
            record["outcome"] = f"400 {error.body['detailedError']['code']}"
        except (KeyError, TypeError):
            record["outcome"] = "400"

    async def recording_get_json(self, url, params, **kwargs):
        record: dict[str, Any] = {**label(url), "outcome": None}
        body = await budget.run(
            1, record, lambda: real_get_json(self, url, params, **kwargs), note_error
        )
        record["outcome"] = "ok"
        record.update(describe(body))
        return body

    Outbound.get_json = recording_get_json
    return budget.records


def write_summary(output: str, summary: dict[str, Any]) -> None:
    """Write the summary as JSON to `output` and print it."""
    with open(output, "w") as out:
        json.dump(summary, out, indent=1)
    print(json.dumps(summary, indent=1))


class LocationMeter:
    """For the length of a `with` block: counts the locations of every Open-Meteo form POST,
    refuses one that would pass the budget, and records each request's status, timing and
    rate-limit headers. GET calls pass through. Restores `Outbound` on exit."""

    HEADERS = ("x-ratelimit-cost", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after")

    def __init__(self, budget: int) -> None:
        self.budget = Budget(budget, "location")
        self.phase = ""
        self.origin = time.monotonic()

    @property
    def spent(self) -> int:
        return self.budget.spent

    @property
    def records(self) -> list[dict[str, Any]]:
        return self.budget.records

    def __enter__(self) -> "LocationMeter":
        self._real_send = Outbound._send
        meter = self

        async def metered(outbound, method, url, timeout, connect_timeout, content):
            if method != "POST":
                return await meter._real_send(
                    outbound, method, url, timeout, connect_timeout, content
                )
            locations = len(content["data"]["latitude"].split(","))
            record: dict[str, Any] = {
                "phase": meter.phase,
                "locations": locations,
                "at_s": round(time.monotonic() - meter.origin, 1),
                "status": None,
            }

            def note_error(record: dict[str, Any], error: Exception) -> None:
                record["status"] = type(error).__name__

            response = await meter.budget.run(
                locations,
                record,
                lambda: meter._real_send(outbound, method, url, timeout, connect_timeout, content),
                note_error,
            )
            record["status"] = response.status_code
            record["bytes"] = len(response.content)
            record.update({h: response.headers.get(h) for h in meter.HEADERS})
            return response

        Outbound._send = metered
        return self

    def __exit__(self, *exc_info: object) -> None:
        Outbound._send = self._real_send


def plan_stats(plan: LocationPlan) -> dict[str, int]:
    """How many forecast locations a plan needs and how many chunks they go out in."""
    return {
        "checkpoint_cells": len(plan.checkpoint_cells),
        "grid_cells": len(plan.grid),
        "grid_only_cells": len(plan.grid_only_cells),
        "locations": len(plan.cells),
        "chunks": len(chunked(plan.cells)),
    }


def chunked(cells: Sequence[Cell]) -> list[Sequence[Cell]]:
    """The cells in chunks of at most `MAX_LOCATIONS_PER_CALL`, as a weather request sends them."""
    size = MAX_LOCATIONS_PER_CALL
    return [cells[i : i + size] for i in range(0, len(cells), size)]
