from routing import measure_overlap, near_cells
from routing.overlap import MAX_OVERLAP
from tests.route_fixtures import lerp

LA, NY = (34.05, -118.24), (40.71, -74.0)


def overlap(candidate, *others):
    return measure_overlap(candidate, [near_cells(other) for other in others])


def test_the_same_road_overlaps_completely():
    line = lerp(LA, NY, 200)

    assert overlap(line, line).share == 1.0


def test_roads_far_apart_do_not_overlap():
    north = lerp((45.0, -120.0), (45.0, -80.0), 200)
    south = lerp((33.0, -120.0), (33.0, -80.0), 200)

    assert overlap(south, north).share == 0.0


def test_overlap_is_the_share_of_the_candidates_own_length():
    main = lerp((40.0, -120.0), (40.0, -100.0), 200)
    # Runs along the main road for its first half, then leaves it.
    candidate = lerp((40.0, -120.0), (40.0, -110.0), 100) + lerp(
        (40.0, -110.0), (35.0, -105.0), 100
    )

    assert 0.55 < overlap(candidate, main).share < 0.7


def test_the_worst_overlap_over_every_other_route_decides():
    main = lerp((40.0, -120.0), (40.0, -100.0), 200)
    far = lerp((30.0, -120.0), (30.0, -100.0), 200)

    assert overlap(main, far).share == 0.0
    assert overlap(main, far, main).share == 1.0
    assert overlap(main).share == 0.0


def test_a_candidate_is_distinct_only_below_half_of_every_other_route():
    main = lerp((40.0, -120.0), (40.0, -100.0), 200)
    far = lerp((45.0, -120.0), (45.0, -100.0), 200)

    assert MAX_OVERLAP == 0.5
    assert overlap(far, main).distinct
    assert not overlap(main, far, main).distinct
