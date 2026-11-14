from datetime import UTC, datetime, timedelta

import pytest

from risk_rules import Checkpoint, Level, summarize_route
from routing import build_checkpoints, plan_stops
from routing.checkpoints import checkpoint_marks
from tests.route_fixtures import route_from

DEPARTURE = datetime(2026, 11, 13, 8, 0, tzinfo=UTC)
ORIGIN, DESTINATION = (41.0, -100.0), (41.0, -85.0)


def test_marks_start_at_zero_and_end_at_the_destination():
    assert checkpoint_marks(60.0, 25) == [0.0, 25.0, 50.0, 60.0]


def test_an_exact_multiple_does_not_repeat_the_destination():
    assert checkpoint_marks(50.0, 25) == [0.0, 25.0, 50.0]


def test_a_route_shorter_than_the_spacing_has_start_and_destination():
    assert checkpoint_marks(7.5, 25) == [0.0, 7.5]


def test_a_zero_length_route_has_one_mark():
    assert checkpoint_marks(0.0, 25) == [0.0]


def test_a_destination_a_hair_past_a_multiple_is_not_a_second_mark():
    assert checkpoint_marks(50.0000001, 25) == [0.0, 25.0, 50.0000001]


def test_spacing_must_be_positive():
    with pytest.raises(ValueError):
        checkpoint_marks(10.0, 0)


def test_eta_of_the_first_checkpoint_is_the_departure_and_the_last_is_the_arrival():
    route = route_from([ORIGIN, DESTINATION])

    checkpoints = build_checkpoints(route, 25, DEPARTURE)

    assert checkpoints[0].mile == 0
    assert checkpoints[0].eta == DEPARTURE
    assert checkpoints[-1].mile == pytest.approx(route.total_miles)
    assert checkpoints[-1].eta == DEPARTURE + timedelta(seconds=route.travel_time_s)
    assert (checkpoints[0].lat, checkpoints[0].lon) == ORIGIN
    assert (checkpoints[-1].lat, checkpoints[-1].lon) == DESTINATION


def test_etas_interpolate_the_time_knots():
    # Constant speed, so mile 25 is reached after 25 miles of driving.
    route = route_from([ORIGIN, DESTINATION], speed_mps=25.0)

    second = build_checkpoints(route, 25, DEPARTURE)[1]

    expected = 25 * 1609.344 / 25.0
    assert (second.eta - DEPARTURE).total_seconds() == pytest.approx(expected, abs=1.5)


def test_etas_never_go_backwards_and_the_eta_is_utc():
    route = route_from([ORIGIN, (44.0, -92.0), DESTINATION])

    etas = [c.eta for c in build_checkpoints(route, 10, DEPARTURE.astimezone(UTC))]

    assert etas == sorted(etas)
    assert all(eta.utcoffset() == timedelta(0) for eta in etas)


@pytest.mark.parametrize("spacing", [10, 25, 50])
@pytest.mark.parametrize(
    "waypoints",
    [
        pytest.param([ORIGIN, DESTINATION], id="direct"),
        pytest.param([ORIGIN, (44.0, -92.0), DESTINATION], id="with a bend"),
    ],
)
def test_checkpoints_are_accepted_by_the_risk_rules_summary(spacing, waypoints):
    route = route_from(waypoints)
    checkpoints = build_checkpoints(route, spacing, DEPARTURE)

    summary = summarize_route(
        route.total_miles, [Checkpoint(c.mile, Level.LOW) for c in checkpoints]
    )

    assert summary.low_miles == pytest.approx(route.total_miles)


LONG_ORIGIN, LONG_DESTINATION = (41.0, -120.0), (41.0, -85.0)


def test_with_stops_the_etas_include_the_time_stopped_before_each_mark():
    # 25 m/s over about 2,950 km is about 33 h at the wheel: a break, a rest and a second break.
    route = route_from([LONG_ORIGIN, LONG_DESTINATION], speed_mps=25.0)
    stops = plan_stops(route.travel_time_s)

    plain = build_checkpoints(route, 50, DEPARTURE)
    broken = build_checkpoints(route, 50, DEPARTURE, stops)

    assert [c.mile for c in broken] == [c.mile for c in plain]
    assert [(c.lat, c.lon) for c in broken] == [(c.lat, c.lon) for c in plain]
    assert broken[0].eta == DEPARTURE
    stopped = sum(stop.duration_s for stop in stops)
    assert stopped > 0
    assert (broken[-1].eta - plain[-1].eta).total_seconds() == pytest.approx(stopped)
    assert all(b.eta >= p.eta for b, p in zip(broken, plain, strict=True))


def test_checkpoint_etas_with_stops_never_go_backwards_and_jump_across_each_stop():
    route = route_from([LONG_ORIGIN, LONG_DESTINATION], speed_mps=25.0)
    stops = plan_stops(route.travel_time_s)

    checkpoints = build_checkpoints(route, 10, DEPARTURE, stops)

    etas = [c.eta for c in checkpoints]
    assert etas == sorted(etas)
    gaps = [(b - a).total_seconds() for a, b in zip(etas, etas[1:], strict=False)]
    assert sum(gap > 24 * 3600 for gap in gaps) == 0
    assert sum(gap > 10 * 3600 for gap in gaps) == sum(s.kind == "rest" for s in stops)
