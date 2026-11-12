"""The rules package stays free of Django and HTTP code.

pytest-django has already imported Django in this process, so the package is checked from its
source and in a fresh interpreter instead.
"""

import ast
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PACKAGE_DIR = BACKEND_DIR / "risk_rules"


def imported_roots(path: Path) -> set[str]:
    roots = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
    return roots


def test_package_imports_only_the_standard_library():
    sources = sorted(PACKAGE_DIR.glob("*.py"))
    assert sources

    for path in sources:
        outside = imported_roots(path) - sys.stdlib_module_names
        assert not outside, f"{path.name} imports {sorted(outside)}"


def test_importing_the_package_loads_no_django_or_ninja():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, risk_rules; "
            "bad = [m for m in sys.modules if m.split('.')[0] in ('django', 'ninja')]; "
            "sys.exit(1 if bad else 0)",
        ],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
