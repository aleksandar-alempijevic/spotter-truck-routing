"""Provider-neutral errors.

Messages never carry a URL, a key or an upstream body: the providers take their keys in the query
string, so anything derived from a request URL could leak one.
"""


class ProviderError(Exception):
    """Base of every error an outbound provider call can raise."""

    code = "provider_error"
    message = "A provider request failed."

    def __init__(self) -> None:
        super().__init__(self.message)


class ProviderTimeout(ProviderError):
    code = "provider_timeout"
    message = "The routing provider took too long to answer."


class ProviderUnavailable(ProviderError):
    code = "provider_unavailable"
    message = "The routing provider failed to answer correctly."


class ProviderRateLimited(ProviderError):
    code = "provider_limited"
    message = (
        "The routing provider is refusing requests (rate limit, quota or credentials). "
        "Try again later."
    )


class ProviderNotConfigured(ProviderError):
    code = "provider_not_configured"
    message = "The routing provider is not configured on this server."


class NoRouteFound(ProviderError):
    code = "no_route"
    message = "No route could be found between these points."


class MalformedResponse(ProviderError):
    code = "provider_malformed_response"
    message = "The routing provider returned a response that could not be used."
