import math

import pytest

from routing.geo import METERS_PER_MILE, haversine_m
from weather import (
    TooManyLocations,
    cell_center,
    forecast_cell,
    longitude_span_coverable,
    plan_locations,
)
from weather.grid import BLOCK, CORRIDOR_MILES


def test_a_point_belongs_to_its_tenth_of_a_degree_cell():
    assert forecast_cell((39.75, -104.99)) == (397, -1050)
    assert forecast_cell((0.3, 0.7)) == (3, 7)  # 0.3 / 0.1 is 2.9999999999999996 in floats
    assert forecast_cell((-0.05, -0.1)) == (-1, -1)


@pytest.mark.parametrize("cell", [(397, -1050), (0, 0), (-1, -1), (-455, 1799)])
def test_a_cell_centre_lies_in_its_own_cell(cell):
    assert forecast_cell(cell_center(cell)) == cell


def eastward(lat: float, lon_from: float, lon_to: float, steps: int):
    return [(lat, lon_from + (lon_to - lon_from) * i / steps) for i in range(steps + 1)]


def test_no_routes_need_no_locations():
    plan = plan_locations([])

    assert plan.cells == () and plan.grid == ()


def test_a_single_checkpoint_has_a_corridor_of_its_own():
    plan = plan_locations([[(40.05, -100.05)]])

    assert plan.checkpoint_cells == (forecast_cell((40.05, -100.05)),)
    assert plan.grid


def test_checkpoint_cells_are_unique_and_in_the_order_first_met():
    route_a = [(40.01, -100.01), (40.02, -100.02), (40.01, -99.5)]
    route_b = [(40.01, -99.5), (41.0, -99.0)]

    plan = plan_locations([route_a, route_b])

    assert plan.checkpoint_cells == (
        forecast_cell((40.01, -100.01)),
        forecast_cell((40.01, -99.5)),
        forecast_cell((41.0, -99.0)),
    )


def test_the_corridor_holds_the_display_cells_whose_centre_is_near_a_route():
    # Display rows are 0.5 degrees tall: row 80 spans 40.0-40.5 (centre 40.25, 14 miles from the
    # route), row 79 centre 39.75 (21 miles), row 81 centre 40.75 (48 miles).
    plan = plan_locations([eastward(40.05, -100.0, -95.0, 20)])

    assert {cell.row for cell in plan.grid} == {79, 80}
    route = [(40.05, -100.0 + 0.25 * i) for i in range(21)]
    for cell in plan.grid:
        nearest = min(haversine_m((cell.lat, cell.lon), point) for point in route)
        assert nearest / METERS_PER_MILE <= CORRIDOR_MILES + 8  # the route is sampled sparsely


def test_a_display_cell_holding_a_checkpoint_reads_a_checkpoint_forecast():
    plan = plan_locations([eastward(40.05, -100.0, -95.0, 20)])
    held = set(plan.checkpoint_cells)

    # The corridor also reaches past both ends of the route, where no checkpoint lies.
    on_route = [cell for cell in plan.grid if cell.row == 80 and -100.0 <= cell.lon <= -95.0]
    off_route = [cell for cell in plan.grid if cell.row == 79]

    assert all(cell.forecast in held for cell in on_route)
    assert all(cell.forecast not in held for cell in off_route)
    assert {cell.forecast for cell in plan.grid} - held == set(plan.grid_only_cells)
    assert not set(plan.grid_only_cells) & held


def test_a_display_cell_without_a_checkpoint_reads_its_centre_cell():
    plan = plan_locations([eastward(40.05, -100.0, -95.0, 20)])

    for cell in (c for c in plan.grid if c.row == 79):
        assert cell.forecast == (cell.row * BLOCK + BLOCK // 2, cell.column * BLOCK + BLOCK // 2)
        assert (cell.lat, cell.lon) == cell_center(cell.forecast)


def test_every_checkpoint_sits_in_a_corridor_cell():
    route = [(34.0 + 0.2 * i, -118.0 + 0.9 * i) for i in range(60)]

    plan = plan_locations([route])

    blocks = {(cell.row, cell.column) for cell in plan.grid}
    for point in route:
        row, column = forecast_cell(point)
        assert (row // BLOCK, column // BLOCK) in blocks


def test_the_cells_to_fetch_list_the_checkpoints_first_with_no_repeats():
    plan = plan_locations([eastward(40.05, -100.0, -95.0, 20)])

    assert plan.cells[: len(plan.checkpoint_cells)] == plan.checkpoint_cells
    assert len(set(plan.cells)) == len(plan.cells)
    assert {cell.forecast for cell in plan.grid} <= set(plan.cells)


def test_the_plan_does_not_depend_on_the_order_of_the_routes():
    a = eastward(40.05, -100.0, -95.0, 20)
    b = eastward(36.05, -100.0, -95.0, 20)

    assert plan_locations([a, b]).grid == plan_locations([b, a]).grid


def test_planning_stops_once_the_checkpoint_cells_pass_the_bound():
    route = [(30.0 + 0.1 * i, -100.0) for i in range(50)]

    assert len(plan_locations([route], max_locations=10_000).checkpoint_cells) == 50
    with pytest.raises(TooManyLocations):
        plan_locations([route], max_locations=49)


def test_planning_stops_once_the_corridor_passes_the_bound_however_the_routes_are_shaped(
    monkeypatch,
):
    # Checkpoints a mile and a half apart on the ground that flip across the antimeridian: the
    # planar sweep sees the whole map between them. Without a bound this planned over 100,000
    # cells; with one, the work stays near the bound.
    route = [(40.0 + 0.04 * i, -179.99 if i % 2 == 0 else 179.99) for i in range(600)]
    from weather import grid

    calls = 0
    real = grid.distance_to_segment_miles

    def counting(*args):
        nonlocal calls
        calls += 1
        return real(*args)

    monkeypatch.setattr(grid, "distance_to_segment_miles", counting)

    with pytest.raises(TooManyLocations):
        plan_locations([route, route, route], max_locations=1800)

    assert calls < 20_000


def eastward_route(lat, count=600, lon=-125.0, miles=10):
    points = []
    for _ in range(count):
        points.append((lat, lon))
        lon += miles / (69.09 * math.cos(math.radians(lat)))
    return points


def test_the_bound_applies_to_the_total_not_only_to_the_checkpoint_cells():
    routes = [eastward_route(lat) for lat in (30, 40, 48)]
    unbounded = plan_locations(routes)

    # The checkpoints alone fit the bound; the grid cells beside them take the total past it.
    assert len(unbounded.checkpoint_cells) <= 1800 < len(unbounded.cells)
    with pytest.raises(TooManyLocations):
        plan_locations(routes, max_locations=1800)
    assert len(plan_locations(routes, max_locations=len(unbounded.cells)).cells) == len(
        unbounded.cells
    )


@pytest.mark.parametrize(
    ("a", "b", "coverable"),
    [
        ((40.0, -100.0), (40.0, -99.2), True),  # 41 miles at 40 degrees north
        ((40.0, -100.0), (40.0, -98.0), False),
        ((64.0, -150.0), (64.0, -148.4), True),
        ((40.0, -179.99), (40.0, 179.99), False),  # 1.4 miles on the ground, the whole map apart
        ((89.99, -20.0), (89.99, 20.0), True),  # near a pole the floor keeps the span finite
    ],
)
def test_a_segment_is_coverable_when_its_longitude_span_fits_its_miles(a, b, coverable):
    assert longitude_span_coverable(a, b, 50.0) is coverable


@pytest.mark.parametrize(
    "route",
    [
        [(89.95, -170.0), (89.95, -126.5)],
        [(89.95, 179.0), (89.95, 179.95)],
        [(40.0, 179.0), (40.0, 179.95)],
        [(-89.95, -179.95), (-89.95, -179.0)],
    ],
    ids=["north pole", "pole and the antimeridian", "the antimeridian", "south pole"],
)
def test_the_corridor_leaves_out_cells_whose_centre_is_off_the_map(route):
    plan = plan_locations([route])

    assert plan.grid
    # Every kept cell is on the map, and none was clamped onto the edge to stand in for a
    # skipped one: each display cell reads a request point of its own.
    for cell in plan.grid:
        assert -90 <= cell.lat <= 90 and -180 <= cell.lon <= 180
    assert len({(cell.lat, cell.lon) for cell in plan.grid}) == len(plan.grid)
    assert len({cell_center(c) for c in plan.cells}) == len(plan.cells)
    for point in plan.cells:
        assert -90 <= cell_center(point)[0] <= 90 and -180 <= cell_center(point)[1] <= 180


def test_cells_beyond_a_pole_are_absent_from_the_corridor():
    near_pole = plan_locations([[(89.95, -100.0), (89.95, -99.0)]])
    rows = {cell.row for cell in near_pole.grid}

    # Display row 179 is 89.5 to 90.0 (centre 89.75), the last on the map. Row 180 would be
    # centred at 90.25, 16 miles from the route: in the corridor if it were not left out.
    assert rows == {179}
