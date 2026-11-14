"""Serve the built frontend (`/` and `/assets/*`) in front of the Django application.

This is an ASGI wrapper rather than a Django middleware on purpose. WhiteNoise's Django
middleware (6.12) is synchronous only, and one sync-only middleware makes Django run every
`/api/*` request through a thread. The wrapper answers its two paths itself and hands every
other request, including lifespan, to the application untouched, so `/api/` is never served
from here and the request path of the API stays async.

The build is read into memory once, at start-up: it is about 2.3 MB, there is no file I/O on
the request path, and a request can only ever name a file that was in the build (no path
joining, so no traversal).
"""

import logging
import mimetypes
from collections.abc import Awaitable, Callable, MutableMapping
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

# Set explicitly: a browser refuses to run a module worker served with any other script type,
# and the platform's mime table decides `.mjs` otherwise.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
}
# Hashed build output never changes under its name; the entry page names the current files.
IMMUTABLE = b"public, max-age=31536000, immutable"
REVALIDATE = b"no-cache"


def content_type(path: Path) -> str:
    return (
        CONTENT_TYPES.get(path.suffix)
        or mimetypes.guess_type(path.name)[0]
        or ("application/octet-stream")
    )


class StaticBuild:
    def __init__(self, app: ASGIApp, dist_dir: Path):
        self.app = app
        self.files: dict[str, tuple[bytes, list[tuple[bytes, bytes]]]] = {}
        if not (dist_dir / "index.html").is_file():
            logger.warning("No built frontend at %s; only the API is served.", dist_dir)
            return
        self._add("/", dist_dir / "index.html", REVALIDATE)
        for file in sorted((dist_dir / "assets").rglob("*")):
            if file.is_file():
                url = "/assets/" + file.relative_to(dist_dir / "assets").as_posix()
                self._add(url, file, IMMUTABLE)

    def _add(self, url: str, file: Path, cache_control: bytes) -> None:
        body = file.read_bytes()
        headers = [
            (b"content-type", content_type(file).encode()),
            (b"content-length", str(len(body)).encode()),
            (b"cache-control", cache_control),
            (b"x-content-type-options", b"nosniff"),
        ]
        self.files[url] = (body, headers)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        entry = self.files.get(scope["path"]) if scope["type"] == "http" else None
        if entry is None:
            await self.app(scope, receive, send)
            return
        body, headers = entry
        if scope["method"] not in ("GET", "HEAD"):
            await send(
                {
                    "type": "http.response.start",
                    "status": 405,
                    "headers": [(b"allow", b"GET, HEAD"), (b"content-length", b"0")],
                }
            )
            await send({"type": "http.response.body", "body": b""})
            return
        await send({"type": "http.response.start", "status": 200, "headers": headers})
        await send(
            {"type": "http.response.body", "body": b"" if scope["method"] == "HEAD" else body}
        )
