from routing import order_routes, simplify_line
from tests.route_fixtures import lerp, route_from


def test_a_straight_line_reduces_to_its_ends():
    line = lerp((40.0, -100.0), (40.0, -90.0), 500)

    assert simplify_line(line) == [line[0], line[-1]]


def test_a_corner_is_kept():
    line = lerp((40.0, -100.0), (40.0, -95.0), 100) + lerp((40.0, -95.0), (45.0, -95.0), 100)[1:]

    reduced = simplify_line(line)

    assert reduced[0] == line[0] and reduced[-1] == line[-1]
    assert (40.0, -95.0) in reduced
    assert len(reduced) == 3


def test_every_dropped_point_stays_within_the_tolerance():
    line = [(40.0 + 0.0005 * (i % 2), -100.0 + 0.01 * i) for i in range(200)]

    assert len(simplify_line(line, tolerance=0.001)) == 2
    assert len(simplify_line(line, tolerance=0.0001)) > 2


def test_short_lines_are_returned_as_they_are():
    assert simplify_line([(1.0, 2.0)]) == [(1.0, 2.0)]
    assert simplify_line([(1.0, 2.0), (3.0, 4.0)]) == [(1.0, 2.0), (3.0, 4.0)]


def test_routes_are_ordered_by_time_then_miles_and_get_unique_ids():
    fast = route_from([(40.0, -100.0), (40.0, -90.0)], speed_mps=30.0)
    slow = route_from([(40.0, -100.0), (41.0, -90.0)], speed_mps=20.0)
    longer_same_time = route_from([(40.0, -100.0), (42.0, -90.0)], speed_mps=20.0 * 1.3)

    ordered = order_routes([slow, longer_same_time, fast])

    assert [route_id for route_id, _ in ordered] == ["route-1", "route-2", "route-3"]
    times = [route.travel_time_s for _, route in ordered]
    assert times == sorted(times)
    assert ordered[0][1] is fast


def test_the_same_routes_get_the_same_ids_whatever_the_input_order():
    a = route_from([(40.0, -100.0), (40.0, -90.0)])
    b = route_from([(40.0, -100.0), (43.0, -90.0)])

    assert order_routes([a, b]) == order_routes([b, a])


def test_ties_in_time_and_miles_still_give_unique_ids():
    a = route_from([(40.0, -100.0), (40.0, -90.0)])

    ids = [route_id for route_id, _ in order_routes([a, a, a])]

    assert ids == ["route-1", "route-2", "route-3"]
