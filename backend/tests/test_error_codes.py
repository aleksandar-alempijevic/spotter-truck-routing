import typing

from api.schemas import ErrorCode, ErrorOut
from providers import ProviderError


def subclasses(cls: type) -> set[type]:
    return {cls} | {sub for child in cls.__subclasses__() for sub in subclasses(child)}


def test_every_provider_error_code_is_in_the_declared_set():
    declared = set(typing.get_args(ErrorCode))

    for error in subclasses(ProviderError):
        assert error.code in declared, error.__name__
        ErrorOut(code=error.code, message=error.message)


def test_provider_errors_have_distinct_codes_and_no_provider_specific_wording():
    errors = subclasses(ProviderError)

    assert len({error.code for error in errors}) == len(errors)
    for error in errors:
        assert "routing" not in error.message.lower(), error.__name__


def test_the_validation_code_is_declared():
    assert "validation_error" in typing.get_args(ErrorCode)
