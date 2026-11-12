"""Errors the API answers itself, apart from validation and the provider errors."""

from .schemas import ErrorCode

API_ERRORS: dict[int, tuple[ErrorCode, str, int]] = {
    404: ("not_found", "There is no such API path.", 404),
    405: ("method_not_allowed", "This path does not accept that HTTP method.", 405),
    500: ("internal_error", "The server failed to handle the request.", 500),
}
"""Status -> (code, message, status) for the answers that are not a validation or provider error."""
