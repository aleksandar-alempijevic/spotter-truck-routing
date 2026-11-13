"""Layering of the routing and providers packages, checked from their source."""

import ast
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def imported_roots(path: Path) -> set[str]:
    roots = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
    return roots


def package_imports(package: str) -> dict[str, set[str]]:
    sources = sorted((BACKEND_DIR / package).glob("*.py"))
    assert sources
    return {path.name: imported_roots(path) for path in sources}


def test_routing_imports_only_the_standard_library():
    for name, roots in package_imports("routing").items():
        outside = roots - sys.stdlib_module_names
        assert not outside, f"routing/{name} imports {sorted(outside)}"


def test_importing_routing_loads_no_django_ninja_or_httpx():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, routing; "
            "bad = [m for m in sys.modules if m.split('.')[0] in ('django', 'ninja', 'httpx')]; "
            "sys.exit(1 if bad else 0)",
        ],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_providers_import_neither_the_api_layer_nor_the_rules_nor_django():
    for name, roots in package_imports("providers").items():
        assert not roots & {"api", "risk_rules", "django", "ninja"}, f"providers/{name}: {roots}"


def test_weather_imports_only_the_standard_library_and_routing():
    for name, roots in package_imports("weather").items():
        outside = roots - sys.stdlib_module_names - {"routing"}
        assert not outside, f"weather/{name} imports {sorted(outside)}"


def test_importing_weather_loads_no_django_ninja_or_httpx():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, weather; "
            "bad = [m for m in sys.modules if m.split('.')[0] in ('django', 'ninja', 'httpx')]; "
            "sys.exit(1 if bad else 0)",
        ],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_only_providers_import_httpx():
    for package in ("routing", "weather", "api", "risk_rules"):
        for name, roots in package_imports(package).items():
            assert "httpx" not in roots, f"{package}/{name} imports httpx"


def test_routing_weather_and_the_rules_do_not_import_each_other():
    for name, roots in package_imports("routing").items():
        assert not roots & {"risk_rules", "weather"}, f"routing/{name}"
    for name, roots in package_imports("weather").items():
        assert "risk_rules" not in roots, f"weather/{name}"
    for name, roots in package_imports("risk_rules").items():
        assert not roots & {"routing", "weather"}, f"risk_rules/{name}"
