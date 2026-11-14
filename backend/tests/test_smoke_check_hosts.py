"""The smoke check's rule for a foreign Host: the app's 400 always, Cloudflare's 403 only from the
edge."""

import importlib.util

import pytest

from .test_settings import BACKEND_DIR

spec = importlib.util.spec_from_file_location(
    "smoke_check", BACKEND_DIR.parent / "scripts" / "smoke_check.py"
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


@pytest.mark.parametrize(
    ("status", "headers", "body", "refused", "who"),
    [
        (400, {"server": "uvicorn"}, b"<h1>Bad Request (400)</h1>", True, "the app, 400"),
        (403, {"server": "cloudflare"}, b"Forbidden", True, "the edge, 403"),
        (403, {"server": "Cloudflare"}, b"Forbidden", True, "the edge, 403"),
        (403, {"server": "uvicorn"}, b"Forbidden", False, "the app, 400"),  # no edge: strict
        (403, {}, b"Forbidden", False, "the app, 400"),
        (200, {"server": "cloudflare"}, b"ok", False, "the app, 400"),
        (400, {"server": "uvicorn"}, b'<div id="root"></div>', False, "the app, 400"),  # the page
    ],
)
def test_a_foreign_host_is_refused_by_the_app_or_by_the_edge_and_not_otherwise(
    status, headers, body, refused, who
):
    assert smoke.foreign_host_refusal(status, headers, body) == (refused, who)
