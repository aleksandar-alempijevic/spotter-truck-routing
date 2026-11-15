import logging
import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def import_base_settings(
    code: str = "import config.base", **env: str
) -> subprocess.CompletedProcess[str]:
    """Run `code` (by default, an import of the shared settings) in a clean process with exactly
    the given environment."""
    return subprocess.run(
        [sys.executable, "-c", code],
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


def test_info_lines_reach_the_console_once_and_http_client_lines_do_not():
    """Under the shared settings an INFO line from the app or Django is printed, once; httpx and
    httpcore, whose lines carry request URLs and so API keys, stay at WARNING."""
    code = (
        "import logging, django; django.setup()\n"
        "logging.getLogger('api.weather_report').info('app-line')\n"
        "logging.getLogger('django.request').warning('django-line')\n"
        "logging.getLogger('httpx').info('httpx-line')\n"
        "logging.getLogger('httpcore.connection').info('httpcore-line')\n"
        "print(logging.getLogger('httpx').getEffectiveLevel(),"
        " logging.getLogger('httpcore').getEffectiveLevel())\n"
    )

    result = import_base_settings(
        code, DJANGO_SETTINGS_MODULE="config.base", DJANGO_SECRET_KEY="x", DJANGO_DEBUG="1"
    )

    assert result.returncode == 0, result.stderr
    assert result.stderr.count("app-line") == 1
    assert result.stderr.count("django-line") == 1
    assert "httpx-line" not in result.stderr
    assert "httpcore-line" not in result.stderr
    assert result.stdout.split() == [str(logging.WARNING)] * 2
