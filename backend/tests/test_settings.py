import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def import_base_settings(**env: str) -> subprocess.CompletedProcess[str]:
    """Import the shared settings in a clean process with exactly the given environment."""
    return subprocess.run(
        [sys.executable, "-c", "import config.base"],
        cwd=BACKEND_DIR,
        env={"PATH": os.environ.get("PATH", ""), **env},
        capture_output=True,
        text=True,
    )


def test_debug_off_without_secret_key_refuses_to_start():
    result = import_base_settings()

    assert result.returncode != 0
    assert "DJANGO_SECRET_KEY must be set" in result.stderr


def test_debug_on_without_secret_key_starts():
    assert import_base_settings(DJANGO_DEBUG="1").returncode == 0


def test_secret_key_alone_is_enough_with_debug_off():
    assert import_base_settings(DJANGO_SECRET_KEY="x").returncode == 0
