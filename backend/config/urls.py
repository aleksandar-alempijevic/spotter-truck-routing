"""URL table: everything under /api/ is handled by Django Ninja."""

from django.urls import path

from api.api import api

urlpatterns = [path("api/", api.urls)]
