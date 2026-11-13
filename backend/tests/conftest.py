import pytest
import respx


@pytest.fixture(autouse=True)
def provider_mock():
    """Every test runs with outbound HTTP mocked: an unmocked request fails the test."""
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        yield router
