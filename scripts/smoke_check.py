"""Tier-0 deploy smoke check: one origin, asset types, error contract, host list, keyless 503.

    python scripts/smoke_check.py BASE_URL [--keys-set]

Standard library only, so it runs against the local container and, unchanged, against the
hosted URL. It spends no provider quota: the one provider-backed request is made with the key
absent, where the app answers before calling anyone. Pass --keys-set once the provider keys
are configured to skip that check (it would reach the live provider). Exit status is 0 only if
every check passed.
"""

import json
import re
import sys
import urllib.error
import urllib.request

ASSET_REF = re.compile(r"/?assets/[A-Za-z0-9_.-]+\.(?:js|mjs|css)")
JS_TYPES = ("text/javascript", "application/javascript")


def lowered(headers) -> dict[str, str]:
    return {k.lower(): v for k, v in headers.items()}


def fetch(base: str, path: str, method: str = "GET", host: str | None = None):
    """Return (status, lowercase headers, body bytes); HTTP error statuses are results."""
    request = urllib.request.Request(base + path, method=method)
    if host:
        request.add_header("Host", host)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, lowered(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, lowered(error.headers), error.read()


def asset_paths(base: str) -> list[str]:
    """The built files the page needs: the entry's references, then what the entry and the lazy
    map chunk reference in turn (the map chunk and the worker are named only inside scripts)."""
    found: list[str] = []
    queue = [fetch(base, "/")[2].decode()]
    while queue:
        for ref in ASSET_REF.findall(queue.pop()):
            path = "/" + ref.lstrip("/")
            if path not in found:
                found.append(path)
                if path.endswith(".js"):
                    queue.append(fetch(base, path)[2].decode())
    return found


def run(base: str, keys_set: bool) -> list[str]:
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(
            f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else "")
        )
        if not ok:
            failures.append(name)

    def api_error(path: str, method: str, status: int, code: str, **kw) -> None:
        got, headers, body = fetch(base, path, method, **kw)
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = None
        ok = (
            got == status
            and isinstance(parsed, dict)
            and set(parsed) == {"code", "message"}
            and parsed["code"] == code
            and headers.get("content-type", "").startswith("application/json")
        )
        check(f"{method} {path} -> {status} {code}", ok, f"status {got}, body {body[:80]!r}")

    status, _, body = fetch(base, "/api/health")
    check(
        "GET /api/health -> 200 ok",
        status == 200 and json.loads(body) == {"status": "ok"},
        str(status),
    )

    status, headers, body = fetch(base, "/")
    check(
        "GET / -> html, never cached",
        status == 200
        and headers.get("content-type", "").startswith("text/html")
        and "no-cache" in headers.get("cache-control", "")
        and b'id="root"' in body,
        f"{status} {headers.get('content-type')} {headers.get('cache-control')}",
    )

    paths = asset_paths(base)
    kinds = {
        "entry script": lambda p: p.endswith(".js") and "/index-" in p,
        "map chunk": lambda p: p.endswith(".js") and "/MapView-" in p,
        "map stylesheet": lambda p: p.endswith(".css"),
        "map worker": lambda p: p.endswith(".mjs") and "worker" in p,
    }
    for label, matches in kinds.items():
        path = next((p for p in paths if matches(p)), None)
        if path is None:
            check(f"{label} is referenced by the build", False, f"found {paths}")
            continue
        status, headers, _ = fetch(base, path)
        type_ = headers.get("content-type", "").split(";")[0]
        want = ("text/css",) if path.endswith(".css") else JS_TYPES
        cache = headers.get("cache-control", "")
        check(
            f"{label} {path}: {type_}, immutable",
            status == 200
            and type_ in want
            and "immutable" in cache
            and "max-age=31536000" in cache,
            f"{status} {type_} {cache}",
        )

    status, headers, body = fetch(base, "/assets/missing-0000.js")
    check(
        "unknown /assets path is a 404, not the page",
        status == 404 and b'id="root"' not in body,
        str(status),
    )

    api_error("/api/no-such-path", "GET", 404, "not_found")
    api_error("/api/health", "POST", 405, "method_not_allowed")

    for path in ("/api/health", "/", paths[0] if paths else "/assets/"):
        status, _, body = fetch(base, path, host="not-allowed.invalid")
        check(
            f"foreign Host header is refused on {path}",
            status == 400 and b'id="root"' not in body,
            str(status),
        )

    if keys_set:
        print("SKIP  keyless 503 (--keys-set)")
    else:
        api_error("/api/address-search?q=chicago", "GET", 503, "provider_not_configured")
    return failures


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        sys.exit(__doc__)
    failed = run(args[0].rstrip("/"), keys_set="--keys-set" in sys.argv)
    print(f"\n{'FAILED: ' + ', '.join(failed) if failed else 'All tier-0 checks passed.'}")
    sys.exit(1 if failed else 0)
