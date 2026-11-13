"""Errors the API answers itself, apart from validation and the provider errors."""

from .schemas import OUTSIDE_SERVICE_AREA, TOO_MANY_LOCATIONS, ErrorCode

API_ERRORS: dict[int, tuple[ErrorCode, str, int]] = {
    404: ("not_found", "There is no such API path.", 404),
    405: ("method_not_allowed", "This path does not accept that HTTP method.", 405),
    500: ("internal_error", "The server failed to handle the request.", 500),
}
"""Status -> (code, message, status) for the answers that are not a validation or provider error."""

VALIDATION_ERROR_CODES: dict[str, ErrorCode] = {
    OUTSIDE_SERVICE_AREA: "outside_service_area",
    TOO_MANY_LOCATIONS: "too_many_locations",
}
"""Validation error type -> the code its 422 answers with. Any other validation failure is a
plain `validation_error`. The type is set where the error is raised, so nothing reads the
message text."""
