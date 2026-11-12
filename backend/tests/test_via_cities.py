from routing import via_candidates
from routing.via_cities import CITIES
from tests.route_fixtures import lerp

LA, NY = CITIES["Los Angeles"], CITIES["New York"]
DENVER, ALBUQUERQUE = CITIES["Denver"], CITIES["Albuquerque"]
NORTH = lerp(LA, DENVER, 200) + lerp(DENVER, NY, 200)
SOUTH = lerp(LA, ALBUQUERQUE, 200) + lerp(ALBUQUERQUE, NY, 200)


def names(routes, **kwargs) -> list[str]:
    return [via.name for via in via_candidates(LA, NY, routes, **kwargs)]


def test_the_best_city_of_each_side_comes_first():
    assert set(names([NORTH])[:2]) == {"Chicago", "Albuquerque"}


def test_up_to_three_cities_per_side_are_offered_and_the_sides_alternate():
    found = names([lerp(LA, NY, 400)])

    assert found == [
        "Kansas City",
        "Amarillo",
        "Chicago",
        "Oklahoma City",
        "Omaha",
        "Nashville",
    ]


def test_the_number_per_side_can_be_narrowed():
    assert len(names([NORTH], per_side=1)) == 2


def test_a_city_on_any_route_in_hand_is_not_a_candidate():
    assert "Denver" not in names([NORTH])
    assert "Albuquerque" not in names([NORTH, SOUTH])
    assert "Albuquerque" in names([NORTH])


def test_candidates_are_chosen_against_every_route_not_only_the_first():
    only_north = set(names([NORTH]))
    both = set(names([NORTH, SOUTH]))

    assert both != only_north
    assert "Albuquerque" in only_north - both


def test_a_short_trip_has_no_candidates_because_every_city_is_too_close_to_the_route():
    chicago, indianapolis = CITIES["Chicago"], CITIES["Indianapolis"]

    assert via_candidates(chicago, indianapolis, [lerp(chicago, indianapolis, 50)]) == []


def test_identical_ends_have_no_candidates():
    assert via_candidates(LA, LA, [[LA, LA]]) == []
