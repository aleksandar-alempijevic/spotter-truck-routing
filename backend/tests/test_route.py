import pytest

from routing import Route
from routing.geo import METERS_PER_MILE, haversine_m
from routing.route import RouteContractError
from tests.route_fixtures import lerp

START, END = (40.0, -100.0), (40.0, -90.0)


def make_route(**overrides) -> Route:
    points = tuple(lerp(START, END, 100))
    length = haversine_m(START, END)
    fields = {
        "points": points,
        "length_m": length,
        "travel_time_s": 1000.0,
        "knots": ((0.0, 0.0), (length / 2, 300.0), (length, 1000.0)),
    }
    return Route(**{**fields, **overrides})


def test_seconds_interpolate_between_knots():
    route = make_route()
    half = route.length_m / 2

    assert route.seconds_at(half / 2) == pytest.approx(150.0)
    assert route.seconds_at(half) == pytest.approx(300.0)
    assert route.seconds_at(half + (route.length_m - half) / 2) == pytest.approx(650.0)


def test_seconds_clamp_at_both_ends():
    route = make_route()

    assert route.seconds_at(-5) == 0
    assert route.seconds_at(route.length_m * 2) == 1000.0


def test_meters_at_inverts_seconds_at_between_knots():
    route = make_route()

    for meters in (0.0, 1000.0, route.length_m / 2, route.length_m * 0.8, route.length_m):
        assert route.meters_at(route.seconds_at(meters)) == pytest.approx(meters)


def test_meters_at_clamps_at_both_ends():
    route = make_route()

    assert route.meters_at(-5) == 0
    assert route.meters_at(0) == 0
    assert route.meters_at(1000.0) == pytest.approx(route.length_m)
    assert route.meters_at(5000.0) == route.length_m


def test_meters_at_holds_still_where_time_passes_without_distance():
    # A standstill from 400 s to 700 s at the halfway point.
    length = haversine_m(START, END)
    route = make_route(
        knots=((0.0, 0.0), (length / 2, 400.0), (length / 2, 700.0), (length, 1000.0))
    )

    assert route.meters_at(500.0) == pytest.approx(length / 2)
    assert route.meters_at(700.0) == pytest.approx(length / 2)
    assert route.meters_at(850.0) == pytest.approx(length * 0.75)


def test_meters_at_takes_the_start_of_a_jump_where_distance_is_covered_without_time():
    length = haversine_m(START, END)
    route = make_route(
        knots=((0.0, 0.0), (length / 4, 400.0), (length / 2, 400.0), (length, 1000.0))
    )

    assert route.meters_at(400.0) == pytest.approx(length / 4)
    assert route.meters_at(700.0) == pytest.approx(length * 0.75)


def test_meters_at_before_a_first_knot_that_starts_late_is_the_start():
    length = haversine_m(START, END)
    route = make_route(knots=((0.0, 50.0), (length, 1000.0)))

    assert route.meters_at(30.0) == 0


def test_position_follows_the_polyline_on_the_routes_own_length_scale():
    # The route's length is declared 10% longer than the polyline measures: distances scale to it.
    route = make_route(length_m=haversine_m(START, END) * 1.1, travel_time_s=1000.0)
    route = make_route(length_m=route.length_m, knots=((0.0, 0.0), (route.length_m, 1000.0)))

    lat, lon = route.position_at(route.length_m / 2)

    assert lat == pytest.approx(40.0)
    assert lon == pytest.approx(-95.0, abs=1e-6)
    assert route.position_at(route.length_m) == END
    assert route.position_at(0) == START


def test_total_miles_come_from_the_declared_length():
    assert make_route().total_miles == pytest.approx(make_route().length_m / METERS_PER_MILE)


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param(
            {"knots": ((0.0, 0.0), (500.0, 600.0), (900.0, 500.0), (1000.0, 1000.0))},
            id="seconds go backwards",
        ),
        pytest.param(
            {"knots": ((0.0, 0.0), (900.0, 100.0), (800.0, 200.0), (1000.0, 1000.0))},
            id="metres go backwards",
        ),
        pytest.param({"knots": ((0.0, 0.0), (1000.0, 900.0))}, id="last time is not the total"),
        pytest.param({"knots": ()}, id="no knots"),
        pytest.param({"points": ((40.0, -100.0),)}, id="one point"),
        pytest.param({"points": ((40.0, -100.0), (40.0, -100.0))}, id="coinciding points"),
        pytest.param({"points": ((40.0, -100.0), (91.0, -100.0))}, id="latitude out of range"),
        pytest.param({"points": ((40.0, -100.0), (40.0, 181.0))}, id="longitude out of range"),
        pytest.param({"points": ((40.0, -100.0), (float("nan"), -99.0))}, id="NaN latitude"),
        pytest.param({"length_m": 0.0}, id="zero length"),
        pytest.param({"travel_time_s": float("nan")}, id="NaN travel time"),
    ],
)
def test_a_route_that_breaks_the_contract_is_rejected_not_repaired(overrides):
    with pytest.raises(RouteContractError):
        make_route(**overrides)
