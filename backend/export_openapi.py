"""Write the API's OpenAPI schema as JSON: `python export_openapi.py OUTPUT_FILE`.

`make types` runs this under the test settings (no `.env`, no secrets) to feed the frontend's
type generation.
"""

import json
import os
import sys
from pathlib import Path

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings_test")
django.setup()

from ninja.responses import NinjaJSONEncoder  # noqa: E402

from api.api import api  # noqa: E402

if __name__ == "__main__":
    output = Path(sys.argv[1])
    output.write_text(json.dumps(api.get_openapi_schema(), cls=NinjaJSONEncoder))
