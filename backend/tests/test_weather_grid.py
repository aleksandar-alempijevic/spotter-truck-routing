import pytest

from routing.geo import haversine_m
from weather import cell_center, forecast_cell, plan_locations
from weather.grid import BLOCK, CORRIDOR_MILES, METERS_PER_MILE


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
