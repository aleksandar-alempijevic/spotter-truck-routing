import pytest
import respx


@pytest.fixture(autouse=True)
def provider_mock():
    """Every test runs with outbound HTTP mocked: an unmocked request fails the test."""
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        yield router


@pytest.fixture(autouse=True)
def forecast_cache():
    """Each test starts with an empty forecast cache: it is process-wide."""
    from api import weather_report

    weather_report.CACHE.clear()
