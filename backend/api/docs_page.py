"""The interactive API page at /api/docs.

Ninja's own Swagger page asks the server for `/static/` files that nothing here serves (the
static-files app is not installed). Its CDN variant needs none, so this page always renders that
one, while `ninja` stays in INSTALLED_APPS for its management commands.
"""

import json
from pathlib import Path
from typing import Any

from django.http import HttpRequest, HttpResponse
from django.template import RequestContext, Template
from ninja import NinjaAPI
from ninja.openapi.docs import Swagger


class CdnSwagger(Swagger):
    def render_page(self, request: HttpRequest, api: NinjaAPI, **kwargs: Any) -> HttpResponse:
        self.settings["url"] = self.get_openapi_url(api, kwargs)
        page = Template(Path(self.template_cdn).read_text())
        context = {"swagger_settings": json.dumps(self.settings, indent=1), "api": api}
        return HttpResponse(page.render(RequestContext(request, context)))
