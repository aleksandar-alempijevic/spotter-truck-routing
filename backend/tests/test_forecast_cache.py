from datetime import UTC, datetime, timedelta

import pytest

from weather import ForecastCache, ForecastSeries

H14 = datetime(2026, 11, 13, 14, tzinfo=UTC)
H15 = H14 + timedelta(hours=1)


def series(start: datetime) -> ForecastSeries:
    return ForecastSeries(start, (1.0,), (1.0,), (0.0,), (0.0,))


def test_an_entry_is_found_only_for_the_hour_it_starts_at():
    cache = ForecastCache(10)
    cache.put((1, 1), series(H14))

    assert cache.get((1, 1), H14) is not None
    assert cache.get((1, 1), H15) is None
    assert cache.get((2, 2), H14) is None


def test_a_later_hour_drops_every_earlier_entry():
    cache = ForecastCache(10)
    cache.put((1, 1), series(H14))
    cache.put((2, 2), series(H14))

    cache.put((3, 3), series(H15))

    assert len(cache) == 1
    assert cache.get((1, 1), H14) is None
    assert cache.get((3, 3), H15) is not None


def test_a_series_older_than_one_held_is_not_kept():
    cache = ForecastCache(10)
    cache.put((1, 1), series(H15))

    cache.put((2, 2), series(H14))

    assert len(cache) == 1 and cache.get((2, 2), H14) is None


def test_past_the_ceiling_the_entries_stored_longest_ago_go_first():
    cache = ForecastCache(2)
    for cell in [(1, 1), (2, 2), (3, 3)]:
        cache.put(cell, series(H14))

    assert cache.get((1, 1), H14) is None
    assert cache.get((2, 2), H14) is not None and cache.get((3, 3), H14) is not None


def test_storing_a_cell_again_replaces_it_and_makes_it_the_newest():
    cache = ForecastCache(2)
    cache.put((1, 1), series(H14))
    cache.put((2, 2), series(H14))
    cache.put((1, 1), series(H14))
    cache.put((3, 3), series(H14))

    assert cache.get((2, 2), H14) is None and cache.get((1, 1), H14) is not None


def test_clear_empties_the_cache_and_forgets_the_newest_hour():
    cache = ForecastCache(2)
    cache.put((1, 1), series(H15))
    cache.clear()

    cache.put((2, 2), series(H14))

    assert len(cache) == 1


def test_a_cache_needs_room_for_an_entry():
    with pytest.raises(ValueError):
        ForecastCache(0)
