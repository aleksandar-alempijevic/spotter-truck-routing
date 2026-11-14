from datetime import UTC, datetime, timedelta

import pytest

from routing import locate_stops, plan_stops
from routing.rest_breaks import (
    BREAK_AFTER_DRIVING_S,
    BREAK_S,
    CYCLE_DRIVING_S,
    REST_S,
    RESTART_S,
    SHIFT_DRIVING_S,
    StopClock,
)
from tests.route_fixtures import route_from

H = 3600
DEPARTURE = datetime(2026, 11, 13, 8, 0, tzinfo=UTC)


def schedule(driving_s: float) -> list[tuple[str, float]]:
    return [(stop.kind, stop.driving_s / H) for stop in plan_stops(driving_s)]


def test_the_constants_are_the_regulations():
    assert BREAK_AFTER_DRIVING_S == 8 * H
    assert BREAK_S == 30 * 60
    assert SHIFT_DRIVING_S == 11 * H
    assert REST_S == 10 * H
    assert CYCLE_DRIVING_S == 60 * H
    assert RESTART_S == 34 * H


@pytest.mark.parametrize(
    ("driving_s", "expected"),
    [
        pytest.param(0, [], id="no driving"),
        pytest.param(7 * H, [], id="just under 8 h"),
        pytest.param(8 * H, [], id="exactly 8 h ends at the limit"),
        pytest.param(8 * H + 1, [("break", 8)], id="just over 8 h"),
        pytest.param(11 * H, [("break", 8)], id="exactly 11 h ends at the limit"),
        pytest.param(11 * H + 1, [("break", 8), ("rest", 11)], id="just over 11 h"),
        pytest.param(19 * H, [("break", 8), ("rest", 11)], id="a second 8 h ends at the limit"),
        pytest.param(
            19 * H + 1, [("break", 8), ("rest", 11), ("break", 19)], id="second break due"
        ),
        pytest.param(
            22 * H, [("break", 8), ("rest", 11), ("break", 19)], id="exactly 22 h, no second rest"
        ),
        pytest.param(
            22 * H + 1,
            [("break", 8), ("rest", 11), ("break", 19), ("rest", 22)],
            id="second rest due",
        ),
    ],
)
def test_the_schedule_around_each_limit(driving_s, expected):
    assert schedule(driving_s) == [(kind, float(at)) for kind, at in expected]


def test_a_break_every_8_hours_driven_and_a_rest_every_11_over_several_cycles():
    stops = schedule(45 * H)

    assert stops == [
        ("break", 8.0),
        ("rest", 11.0),
        ("break", 19.0),
        ("rest", 22.0),
        ("break", 30.0),
        ("rest", 33.0),
        ("break", 41.0),
        ("rest", 44.0),
    ]


def test_stops_have_the_regulations_durations():
    durations = {stop.kind: stop.duration_seconds for stop in plan_stops(70 * H)}

    assert durations == {"break": 30 * 60, "rest": 10 * H, "restart": 34 * H}


def test_sixty_hours_of_driving_is_the_cycle_limit_and_needs_no_restart():
    kinds = [kind for kind, _ in schedule(60 * H)]

    assert "restart" not in kinds
    assert kinds.count("rest") == 5


def test_a_restart_follows_60_hours_of_driving_and_begins_a_fresh_cycle():
    stops = schedule(60 * H + 1)
    assert stops[-1] == ("restart", 60.0)
    # The restart ends the 8-hour and 11-hour counts too: the next break is 8 h after it.
    assert schedule(68 * H + 1)[-1] == ("break", 68.0)
    assert schedule(71 * H + 1)[-1] == ("rest", 71.0)


@pytest.mark.parametrize("driving_s", [8 * H + 1, 30 * H, 61 * H, 130.5 * H])
def test_stops_ascend_and_all_fall_before_the_end_of_the_trip(driving_s):
    offsets = [stop.driving_s for stop in plan_stops(driving_s)]

    assert offsets == sorted(set(offsets))
    assert offsets[-1] < driving_s


def test_the_door_to_door_time_adds_every_stop():
    stops = plan_stops(12 * H)

    assert StopClock(stops).elapsed_at(12 * H) == 12 * H + BREAK_S + REST_S
    assert StopClock(plan_stops(61 * H)).elapsed_at(61 * H) == (61 + 2.5 + 50 + 34) * H


def test_a_point_exactly_at_a_limit_is_reached_before_the_stop_and_the_next_instant_after():
    stops = plan_stops(12 * H)

    assert StopClock(stops).elapsed_at(8 * H) == 8 * H
    assert StopClock(stops).elapsed_at(8 * H + 1) == 8 * H + 1 + BREAK_S
    assert StopClock(stops).elapsed_at(11 * H) == 11 * H + BREAK_S
    assert StopClock(stops).elapsed_at(11 * H + 1) == 11 * H + 1 + BREAK_S + REST_S


def test_elapsed_time_is_strictly_increasing_in_driving_time():
    stops = plan_stops(70 * H)
    samples = [0, 1, 8 * H - 1, 8 * H, 8 * H + 1, 11 * H, 11 * H + 1, 60 * H, 60 * H + 1, 70 * H]

    clock = StopClock(stops)
    elapsed = [clock.elapsed_at(s) for s in samples]

    assert elapsed == sorted(set(elapsed))


def test_no_stops_means_driving_time_only():
    assert StopClock(()).elapsed_at(9 * H) == 9 * H


def test_a_stop_is_placed_where_the_truck_is_when_the_limit_is_reached():
    # 25 m/s along a straight line: 8 h at the wheel is 720 km in.
    route = route_from([(41.0, -120.0), (41.0, -100.0)], speed_mps=25.0)
    stops = plan_stops(route.travel_time_s)

    located = locate_stops(route, stops, DEPARTURE)

    assert [s.kind for s in located] == ["break", "rest"]
    brk, rest = located
    assert brk.mile * 1609.344 == pytest.approx(8 * H * 25.0, rel=1e-3)
    assert rest.mile * 1609.344 == pytest.approx(11 * H * 25.0, rel=1e-3)
    assert brk.lat == pytest.approx(41.0, abs=1e-6)
    assert -120.0 < brk.lon < rest.lon < -100.0
    assert brk.starts_at == DEPARTURE + timedelta(hours=8)
    assert rest.starts_at == DEPARTURE + timedelta(hours=11, minutes=30)
    assert brk.duration_seconds == BREAK_S
    assert rest.duration_seconds == REST_S
    assert brk.starts_at.utcoffset() == timedelta(0)
