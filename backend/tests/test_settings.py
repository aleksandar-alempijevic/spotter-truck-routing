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


def test_app_info_lines_reach_the_console_and_http_client_lines_do_not():
    """A clean process under the shared settings: INFO from the app's packages is printed, INFO
    from httpx and httpcore (whose lines carry request URLs, so API keys) is not."""
    code = (
        "import logging, django; django.setup()\n"
        "logging.getLogger('api.weather_report').info('app-line')\n"
        "logging.getLogger('providers.outbound').info('provider-line')\n"
        "logging.getLogger('httpx').info('httpx-line')\n"
        "logging.getLogger('httpcore.connection').info('httpcore-line')\n"
        "for name in ('httpx', 'httpcore'):\n"
        "    print(name, logging.getLevelName(logging.getLogger(name).getEffectiveLevel()))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND_DIR,
        env={
            "PATH": os.environ.get("PATH", ""),
            "DJANGO_SETTINGS_MODULE": "config.base",
            "DJANGO_SECRET_KEY": "x",
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "INFO api.weather_report: app-line" in result.stderr
    assert "INFO providers.outbound: provider-line" in result.stderr
    assert result.stdout.splitlines() == ["httpx WARNING", "httpcore WARNING"]
    assert "httpx-line" not in result.stderr
    assert "httpcore-line" not in result.stderr


def test_every_backend_package_that_has_code_logs_at_info():
    """A new top-level package is hidden from the host's log until it is in `APP_LOGGERS`."""
    from config.base import APP_LOGGERS

    packages = {
        path.name
        for path in BACKEND_DIR.iterdir()
        if path.is_dir()
        and not path.name.startswith((".", "__"))
        and path.name != "tests"
        and any(path.rglob("*.py"))
    }

    assert packages <= set(APP_LOGGERS)
