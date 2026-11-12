"""What the live-check scripts share: Django set-up with the app's own settings, a guard on the
number of provider calls, a record of each call, and the output file.

Not part of `make check` or pytest: the scripts that use it spend real provider calls. Nothing
here prints or records a key or a request URL.
"""

import json
import os
import time
from collections.abc import Callable
from typing import Any

from providers.outbound import Outbound, UpstreamBadRequest


def start_django() -> None:
    """Configure Django from `config.settings` (which loads the repository's `.env`)."""
    os.environ.setdefault("DJANGO_DEBUG", "1")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django
    from django.test.utils import setup_test_environment

    django.setup()
    setup_test_environment()


def record_calls(
    max_calls: int,
    label: Callable[[str], dict[str, Any]] = lambda url: {},
    describe: Callable[[Any], dict[str, Any]] = lambda body: {},
) -> list[dict[str, Any]]:
    """Wrap `Outbound.get_json` so every call is recorded and the budget is enforced.

    Each record has `outcome` ("ok", "400 <code>" or the error's class name), `seconds`, whatever
    `label(url)` returns for the call (called before it is made, and must not keep the URL) and,
    for a successful call, whatever `describe(body)` returns. Returns the list the records are
    appended to.
    """
    records: list[dict[str, Any]] = []
    real_get_json = Outbound.get_json

    async def recording_get_json(self, url, params, **kwargs):
        if len(records) >= max_calls:
            raise RuntimeError("provider call budget reached")
        record: dict[str, Any] = {**label(url), "outcome": None}
        records.append(record)
        started = time.monotonic()
        try:
            body = await real_get_json(self, url, params, **kwargs)
        except UpstreamBadRequest as bad:
            try:
                record["outcome"] = f"400 {bad.body['detailedError']['code']}"
            except (KeyError, TypeError):
                record["outcome"] = "400"
            raise
        except Exception as error:
            record["outcome"] = type(error).__name__
            raise
        finally:
            record["seconds"] = round(time.monotonic() - started, 2)
        record["outcome"] = "ok"
        record.update(describe(body))
        return body

    Outbound.get_json = recording_get_json
    return records


def write_summary(output: str, summary: dict[str, Any]) -> None:
    """Write the summary as JSON to `output` and print it."""
    with open(output, "w") as out:
        json.dump(summary, out, indent=1)
    print(json.dumps(summary, indent=1))
