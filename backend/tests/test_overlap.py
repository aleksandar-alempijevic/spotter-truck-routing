from routing import MAX_OVERLAP, is_distinct, near_cells, overlap_share, worst_overlap
from tests.route_fixtures import lerp

LA, DENVER, NY = (34.05, -118.24), (39.74, -104.99), (40.71, -74.0)


def test_the_same_road_overlaps_completely():
    line = lerp(LA, NY, 200)

    assert overlap_share(line, near_cells(line)) == 1.0


def test_roads_far_apart_do_not_overlap():
    north = lerp((45.0, -120.0), (45.0, -80.0), 200)
    south = lerp((33.0, -120.0), (33.0, -80.0), 200)

    assert overlap_share(south, near_cells(north)) == 0.0


def test_overlap_is_the_share_of_the_candidates_own_length():
    main = lerp((40.0, -120.0), (40.0, -100.0), 200)
    # Runs along the main road for its first half, then leaves it.
    candidate = lerp((40.0, -120.0), (40.0, -110.0), 100) + lerp(
        (40.0, -110.0), (35.0, -105.0), 100
    )

    share = overlap_share(candidate, near_cells(main))

    assert 0.55 < share < 0.7


def test_a_candidate_must_be_distinct_from_every_other_route():
    main = lerp(LA, NY, 200)
    far = lerp((45.0, -120.0), (45.0, -74.0), 200)

    assert is_distinct(far, [main])
    assert not is_distinct(main, [far, main])


def test_the_threshold_is_half():
    assert MAX_OVERLAP == 0.5


def test_the_worst_overlap_is_taken_over_every_other_route():
    main = lerp((40.0, -120.0), (40.0, -100.0), 200)
    far = lerp((30.0, -120.0), (30.0, -100.0), 200)

    assert worst_overlap(main, [far]) == 0.0
    assert worst_overlap(main, [far, main]) == 1.0
    assert worst_overlap(main, []) == 0.0
