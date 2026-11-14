"""ASGI entry point: the application object that uvicorn imports and serves.

The Django application sits behind `StaticBuild`, which serves the built frontend at `/` and
`/assets/*` and passes everything else (`/api/`, lifespan) through.
"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

django_application = get_asgi_application()

from django.conf import settings  # noqa: E402

from .static import StaticBuild  # noqa: E402

application = StaticBuild(django_application, settings.FRONTEND_DIST_DIR)
