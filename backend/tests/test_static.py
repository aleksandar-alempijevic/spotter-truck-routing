"""The static layer in front of Django: what it serves, what it leaves alone, and that nothing in
the request path of `/api/` is synchronous."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest
from asgiref.sync import iscoroutinefunction
from django.conf import settings
from django.core.asgi import get_asgi_application
from django.test import Client, RequestFactory, override_settings
from django.utils.module_loading import import_string

from config.static import StaticBuild

from .test_settings import BACKEND_DIR


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><div id=root></div>")
    (tmp_path / "assets" / "index-abc.js").write_text("console.log(1)")
    (tmp_path / "assets" / "MapView-abc.js").write_text("export {}")
    (tmp_path / "assets" / "MapView-abc.css").write_text("body{}")
    (tmp_path / "assets" / "maplibre-gl-worker-abc.mjs").write_text("self.onmessage=0")
    return tmp_path


async def call(
    app, path: str, method: str = "GET", scope_type: str = "http", host: bytes | None = b"localhost"
):
    """Run one request through an ASGI app; returns (status, headers, body)."""
    sent: list[dict] = []

    bodies = [{"type": "http.request", "body": b"", "more_body": False}]

    async def receive():
        if bodies:
            return bodies.pop()
        await asyncio.Event().wait()  # no disconnect until Django cancels the wait

    async def send(message):
        sent.append(message)

    scope = {
        "type": scope_type,
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"host", host)] if host is not None else [],
        "scheme": "http",
        "server": ("localhost", 80),
        "client": ("127.0.0.1", 1),
        "http_version": "1.1",
        "root_path": "",
    }
    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    headers = {k.decode().lower(): v.decode() for k, v in start["headers"]}
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], headers, body


class Recorder:
    """A stand-in application that records what reached it."""

    def __init__(self):
        self.seen: list[tuple[str, str]] = []

    async def __call__(self, scope, receive, send):
        self.seen.append((scope["type"], scope.get("path", "")))


async def test_index_is_html_and_never_cached(dist):
    status, headers, body = await call(StaticBuild(Recorder(), dist), "/")

    assert status == 200
    assert headers["content-type"] == "text/html; charset=utf-8"
    assert headers["cache-control"] == "no-cache"
    assert b"id=root" in body


@pytest.mark.parametrize(
    ("name", "mime"),
    [
        ("index-abc.js", "text/javascript"),
        ("MapView-abc.js", "text/javascript"),
        ("maplibre-gl-worker-abc.mjs", "text/javascript"),
        ("MapView-abc.css", "text/css"),
    ],
)
async def test_hashed_assets_have_their_type_and_cache_forever(dist, name, mime):
    status, headers, _ = await call(StaticBuild(Recorder(), dist), f"/assets/{name}")

    assert status == 200
    assert headers["content-type"].startswith(mime)
    assert "immutable" in headers["cache-control"]
    assert "max-age=31536000" in headers["cache-control"]
    assert headers["x-content-type-options"] == "nosniff"


async def test_head_has_headers_without_a_body(dist):
    status, headers, body = await call(StaticBuild(Recorder(), dist), "/", method="HEAD")

    assert (status, body) == (200, b"")
    assert int(headers["content-length"]) > 0


async def test_other_methods_on_a_served_path_are_405(dist):
    status, headers, _ = await call(StaticBuild(Recorder(), dist), "/", method="POST")

    assert status == 405
    assert headers["allow"] == "GET, HEAD"


@pytest.mark.parametrize(
    "path", ["/api/health", "/api/nope", "/assets/missing.js", "/assets/../index.html", "/x"]
)
async def test_everything_else_goes_to_the_application(dist, path):
    app = Recorder()
    await StaticBuild(app, dist)({"type": "http", "method": "GET", "path": path}, None, None)

    assert app.seen == [("http", path)]


async def test_lifespan_goes_to_the_application(dist):
    app = Recorder()
    await StaticBuild(app, dist)({"type": "lifespan"}, None, None)

    assert app.seen == [("lifespan", "")]


async def test_a_missing_build_serves_nothing_and_does_not_fail(tmp_path):
    app = Recorder()
    static = StaticBuild(app, tmp_path / "absent")
    await static({"type": "http", "method": "GET", "path": "/"}, None, None)

    assert static.files == {}
    assert app.seen == [("http", "/")]


async def test_full_stack_keeps_the_api_error_contract_next_to_the_static_pages(dist):
    app = StaticBuild(get_asgi_application(), dist)

    health = await call(app, "/api/health")
    unknown = await call(app, "/api/nope")
    wrong_method = await call(app, "/api/health", method="POST")
    page = await call(app, "/")

    assert health[0] == 200
    assert json.loads(unknown[2]) == {
        "code": "not_found",
        "message": "There is no such API path.",
    }
    assert unknown[0] == 404
    assert wrong_method[0] == 405
    assert json.loads(wrong_method[2])["code"] == "method_not_allowed"
    assert page[1]["content-type"].startswith("text/html")


def test_every_installed_middleware_is_async_capable():
    """A sync-only middleware makes Django bridge every request through a thread, and the forecast
    cache is only safe on the event loop."""
    for path in settings.MIDDLEWARE:
        middleware = import_string(path)
        assert middleware.async_capable, f"{path} is not async-capable"


def test_the_middleware_chain_is_built_without_a_sync_adapter():
    from django.core.handlers.asgi import ASGIHandler

    handler = ASGIHandler()
    assert iscoroutinefunction(handler._middleware_chain)


def test_foreign_host_is_refused():
    assert Client(HTTP_HOST="evil.example").get("/api/health").status_code == 400


def settings_value(name: str, **env: str) -> str:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"import config.base as b; print(repr(getattr(b, {name!r}, None)))",
        ],
        cwd=BACKEND_DIR,
        env={"PATH": "/usr/bin:/bin", "DJANGO_SECRET_KEY": "x", **env},
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def test_proxy_trust_is_off_unless_the_environment_turns_it_on():
    assert settings_value("SECURE_PROXY_SSL_HEADER") == "None"
    assert settings_value("SECURE_PROXY_SSL_HEADER", DJANGO_TRUST_PROXY_SSL="1") == (
        "('HTTP_X_FORWARDED_PROTO', 'https')"
    )


def test_forwarded_proto_makes_the_request_secure_only_when_trusted():
    request = RequestFactory().get("/", HTTP_X_FORWARDED_PROTO="https")
    assert request.is_secure() is False

    with override_settings(SECURE_PROXY_SSL_HEADER=("HTTP_X_FORWARDED_PROTO", "https")):
        assert RequestFactory().get("/", HTTP_X_FORWARDED_PROTO="https").is_secure() is True
        assert RequestFactory().get("/").is_secure() is False


def test_allowed_hosts_come_only_from_the_environment():
    assert settings_value("ALLOWED_HOSTS", DJANGO_ALLOWED_HOSTS="a.example") == "['a.example']"


def test_the_frontend_directory_follows_the_environment():
    assert settings_value("FRONTEND_DIST_DIR", FRONTEND_DIST_DIR="/srv/dist") == (
        "PosixPath('/srv/dist')"
    )


@pytest.mark.parametrize("path", ["/", "/assets/index-abc.js"])
@pytest.mark.parametrize("host", [b"evil.example", b"", None, b"localhost.evil.example"])
async def test_a_host_django_would_refuse_gets_its_400_on_the_static_paths(dist, path, host):
    status, headers, body = await call(StaticBuild(Recorder(), dist), path, host=host)

    assert status == 400
    assert headers["content-type"].startswith("text/html")
    assert b"id=root" not in body and b"console.log" not in body


@pytest.mark.parametrize(
    ("allowed", "host", "status"),
    [
        (["app.example"], b"app.example", 200),
        (["app.example"], b"app.example:8443", 200),
        (["app.example"], b"APP.example", 200),
        (["app.example"], b"other.example", 400),
        ([".example.com"], b"www.example.com", 200),
        ([".example.com"], b"example.com", 200),
        ([".example.com"], b"example.com.evil.test", 400),
        (["*"], b"anything.test", 200),
        (["app.example"], b"app.example:80:80", 400),
    ],
)
async def test_the_static_host_check_follows_allowed_hosts_as_django_does(
    dist, allowed, host, status
):
    with override_settings(ALLOWED_HOSTS=allowed):
        got = await call(StaticBuild(Recorder(), dist), "/", host=host)
        # Django itself answers the same Host the same way.
        django = await call(get_asgi_application(), "/api/health", host=host)

    assert got[0] == status
    assert django[0] == (400 if status == 400 else 200)
