"""Settings used by the app: loads the repository-root `.env`, then the shared settings.

Real environment variables win over `.env`. The loading is kept out of `base.py`
so tests can use the same settings without ever reading a developer's `.env`.
"""

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from .base import *  # noqa: E402, F403
