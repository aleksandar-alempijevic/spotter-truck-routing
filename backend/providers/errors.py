"""Provider-neutral errors.

Messages never carry a URL, a key or an upstream body: the providers take their keys in the query
string, so anything derived from a request URL could leak one.
"""


class ProviderError(Exception):
    """Base of every error an outbound provider call can raise."""

    code = "provider_error"
    message = "A data provider request failed."
    status = 502
    """The HTTP status the API answers with."""

    def __init__(self) -> None:
        super().__init__(self.message)


class ProviderTimeout(ProviderError):
    code = "provider_timeout"
    status = 504
    message = "A data provider took too long to answer."


class ProviderUnavailable(ProviderError):
    code = "provider_unavailable"
    message = "A data provider failed to answer correctly."


class ProviderRateLimited(ProviderError):
    code = "provider_limited"
    status = 503
    message = (
        "A data provider is refusing requests (rate limit, quota or credentials). Try again later."
    )


class ProviderNotConfigured(ProviderError):
    code = "provider_not_configured"
    status = 503
    message = "A data provider is not configured on this server."


class NoRouteFound(ProviderError):
    code = "no_route"
    status = 422
    message = "No route could be found between these points."


class MalformedResponse(ProviderError):
    code = "provider_malformed_response"
    message = "A data provider returned a response that could not be used."


def error_classes() -> set[type[ProviderError]]:
    """Every provider error class, including those more than one level below the base."""
    found: set[type[ProviderError]] = set()
    stack = [ProviderError]
    while stack:
        error = stack.pop()
        found.add(error)
        stack.extend(error.__subclasses__())
    return found
