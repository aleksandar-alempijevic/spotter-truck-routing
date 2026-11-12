"""Settings for tests: the shared settings without the `.env` load.

Tests must never read a developer's `.env` or reach a live provider, so the
secret key and the provider API keys are fixed dummy values.
"""

import os

os.environ["DJANGO_SECRET_KEY"] = "test-secret-key"
os.environ["TOMTOM_API_KEY"] = "test-tomtom-key"
os.environ["GEOAPIFY_API_KEY"] = "test-geoapify-key"

from .base import *  # noqa: E402, F403
