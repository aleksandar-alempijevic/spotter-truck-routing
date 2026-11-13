import pytest

from routing.geo import MILES_PER_DEGREE, distance_to_segment_miles

A, B = (40.0, -100.0), (40.0, -99.0)


def test_a_point_on_the_segment_is_at_distance_zero():
    assert distance_to_segment_miles((40.0, -99.5), A, B) == pytest.approx(0, abs=1e-9)


def test_the_distance_to_the_middle_of_a_segment_is_the_perpendicular():
    assert distance_to_segment_miles((40.5, -99.5), A, B) == pytest.approx(
        0.5 * MILES_PER_DEGREE, rel=1e-6
    )


def test_beyond_an_end_the_distance_is_to_that_end():
    north_of_b = distance_to_segment_miles((40.2, -98.0), A, B)
    to_end = distance_to_segment_miles((40.2, -98.0), B, B)

    assert north_of_b == pytest.approx(to_end)
    assert north_of_b > 0.2 * MILES_PER_DEGREE


def test_a_segment_of_one_point_is_the_distance_to_it():
    assert distance_to_segment_miles((41.0, -100.0), A, A) == pytest.approx(MILES_PER_DEGREE)
