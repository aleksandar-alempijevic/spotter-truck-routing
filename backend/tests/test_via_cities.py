from routing import CITIES, via_candidates
from tests.route_fixtures import lerp

LA, NY = CITIES["Los Angeles"], CITIES["New York"]


def test_candidates_come_from_both_sides_of_the_main_route():
    denver = CITIES["Denver"]
    main = lerp(LA, denver, 200) + lerp(denver, NY, 200)

    names = [via.name for via in via_candidates(LA, NY, main)]

    assert set(names) == {"Chicago", "Albuquerque"}


def test_a_city_on_the_main_route_is_not_a_candidate():
    denver = CITIES["Denver"]
    main = lerp(LA, denver, 200) + lerp(denver, NY, 200)

    assert "Denver" not in [via.name for via in via_candidates(LA, NY, main)]


def test_at_most_one_candidate_per_side_with_the_least_detour_first():
    main = lerp(LA, NY, 400)

    vias = via_candidates(LA, NY, main)

    assert len(vias) == 2
    assert [via.name for via in vias] == ["Kansas City", "Amarillo"]


def test_a_short_trip_has_no_candidates_because_every_city_is_too_close_to_the_route():
    chicago, indianapolis = CITIES["Chicago"], CITIES["Indianapolis"]

    assert via_candidates(chicago, indianapolis, lerp(chicago, indianapolis, 50)) == []


def test_identical_ends_have_no_candidates():
    assert via_candidates(LA, LA, [LA, LA]) == []
