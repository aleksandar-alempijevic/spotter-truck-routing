import itertools

import pytest

from risk_rules import (
    Checkpoint,
    Level,
    RankingStep,
    RouteCandidate,
    rank_routes,
    summarize_route,
)

L, M, H, S, N = Level.LOW, Level.MODERATE, Level.HIGH, Level.SEVERE, Level.NO_TRAVEL
INTERVAL = 25.0


def route(route_id, levels, minutes=600, interval=INTERVAL, total=None):
    """A route whose checkpoints sit every `interval` miles with the given levels."""
    marks = [Checkpoint(i * interval, level) for i, level in enumerate(levels)]
    total = total if total is not None else len(levels) * interval
    return RouteCandidate(route_id, minutes * 60.0, total, summarize_route(total, marks))


def order(ranking):
    return [r.route_id for r in ranking.routes]


def rank(*routes, interval=INTERVAL):
    return rank_routes(routes, interval)


def test_no_travel_route_ranks_last_even_when_fastest_and_otherwise_safest():
    fast = route("fast", [L, L, N, L], minutes=300)
    slow = route("slow", [S, S, S, S], minutes=900)

    ranking = rank(fast, slow)

    assert order(ranking) == ["slow", "fast"]
    assert ranking.decided_by is RankingStep.NO_TRAVEL
    assert ranking.recommended_id == "slow"
    assert ranking.routes[1].vs_first.dropped_at is RankingStep.NO_TRAVEL


def test_inside_the_no_travel_group_fewest_no_travel_miles_ranks_first_and_nothing_is_recommended():
    a = route("a", [N, N, L, L], minutes=300)
    b = route("b", [N, L, L, L], minutes=900)

    ranking = rank(a, b)

    assert order(ranking) == ["b", "a"]
    assert ranking.recommended_id is None
    assert ranking.decided_by is RankingStep.NO_TRAVEL


def test_one_severe_checkpoint_loses_to_none_however_much_faster():
    ranking = rank(
        route("fast", [L, S, L, L], minutes=60), route("safe", [L, L, L, L], minutes=900)
    )

    assert order(ranking) == ["safe", "fast"]
    assert ranking.decided_by is RankingStep.SEVERE
    assert ranking.recommended_id == "safe"


def test_severe_miles_beyond_float_noise_still_lose():
    safe = route("safe", [L, L, L, L], minutes=900)
    fast = route("fast", [L, L, L, S], minutes=60, total=100.00001)
    assert order(rank(fast, safe)) == ["safe", "fast"]


def test_high_difference_of_more_than_one_interval_decides():
    clean = route("clean", [L, L, L, L], minutes=900)
    two_high = route("two", [L, H, H, L], minutes=300)

    ranking = rank(two_high, clean)

    assert order(ranking) == ["clean", "two"]
    assert ranking.decided_by is RankingStep.HIGH


def test_high_difference_of_exactly_one_interval_is_a_tie_and_time_decides():
    # Equal average risk (0.5), so the High step is the only difference: one interval of High miles.
    clean = route("clean", [M, M, L, L], minutes=900)
    one_high = route("one", [L, H, L, L], minutes=300)

    ranking = rank(clean, one_high)

    assert order(ranking) == ["one", "clean"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME
    assert ranking.routes[1].vs_first.dropped_at is RankingStep.TRAVEL_TIME


def test_high_gap_of_one_interval_counts_as_a_tie_despite_float_rounding():
    # Marks every 0.1 mile accumulate rounding error, so the High gap is 0.1 plus or minus a hair.
    interval = 0.1
    marks_a = [Checkpoint(sum([0.1] * i), M if i in (1, 2) else L) for i in range(11)]
    marks_b = [Checkpoint(sum([0.1] * i), H if i == 5 else L) for i in range(11)]
    total = 1.1
    a = RouteCandidate("a", 3000.0, total, summarize_route(total, marks_a))
    b = RouteCandidate("b", 1000.0, total, summarize_route(total, marks_b))

    ranking = rank_routes([a, b], interval)

    assert order(ranking) == ["b", "a"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_high_gap_a_little_over_one_interval_is_not_a_tie():
    interval = 0.1
    a = RouteCandidate("a", 3000.0, 1.1, summarize_route(1.1, [Checkpoint(0, L)]))
    marks_b = [Checkpoint(0, L), Checkpoint(0.5, H), Checkpoint(0.5 + 0.1 + 1e-3, L)]
    b = RouteCandidate("b", 1000.0, 1.1, summarize_route(1.1, marks_b))

    assert order(rank_routes([a, b], interval)) == ["a", "b"]


def test_average_risk_gap_under_one_over_n_falls_through_to_time():
    # Eight forecasted checkpoints each: one Moderate mile-quarter changes the average by 1/8.
    steady = route("steady", [L] * 8, minutes=900)
    one_moderate = route("one", [M] + [L] * 7, minutes=300)

    ranking = rank(steady, one_moderate)

    assert order(ranking) == ["one", "steady"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_average_risk_gap_over_one_over_n_decides():
    steady = route("steady", [L] * 4, minutes=900)
    two_moderate = route("two", [M, M, L, L], minutes=300)  # average 0.5 > 1/4

    ranking = rank(steady, two_moderate)

    assert order(ranking) == ["steady", "two"]
    assert ranking.decided_by is RankingStep.AVERAGE_RISK


def test_average_risk_gap_of_exactly_one_over_n_is_a_tie():
    steady = route("steady", [L] * 4, minutes=900)
    one_moderate = route("one", [M, L, L, L], minutes=300)  # average 0.25 == 1/4

    assert order(rank(steady, one_moderate)) == ["one", "steady"]


def test_average_risk_edge_holds_despite_float_noise_in_the_miles():
    interval = 0.1
    total = 0.4
    marks = [Checkpoint(sum([0.1] * i), L) for i in range(4)]
    marks_m = [Checkpoint(sum([0.1] * i), M if i == 0 else L) for i in range(4)]
    a = RouteCandidate("a", 3000.0, total, summarize_route(total, marks))
    b = RouteCandidate("b", 1000.0, total, summarize_route(total, marks_m))

    assert order(rank_routes([a, b], interval)) == ["b", "a"]


def test_n_is_the_fewest_forecasted_checkpoints_among_the_routes_still_in_contention():
    # 2 checkpoints on one route makes the tolerance 1/2, so a 0.4 gap is a tie.
    short = route("short", [L, L], minutes=900, interval=50)
    long_ = route("long", [M, M, L, L, L, L, L, L, L, L], minutes=300, interval=10)  # avg 0.2
    assert order(rank_routes([short, long_], 50)) == ["long", "short"]
    # With 10 checkpoints on both, the same 0.2 gap exceeds 1/10.
    short10 = route("short", [L] * 10, minutes=900, interval=10)
    assert order(rank_routes([short10, long_], 10)) == ["short", "long"]


def test_route_with_no_forecast_compares_worse_than_any_average_risk_and_is_reported():
    blind = route("blind", [None, None, None, None], minutes=100)
    sighted = route("sighted", [S, S, S, S], minutes=900)  # Severe: loses on Severe first
    mild = route("mild", [M, M, M, M], minutes=900)

    ranking = rank(blind, mild)

    assert order(ranking) == ["mild", "blind"]
    assert ranking.decided_by is RankingStep.AVERAGE_RISK
    assert {r.route_id: r.no_forecast_miles for r in ranking.routes} == {"mild": 0, "blind": 100}
    assert ranking.routes[1].vs_first.average_risk is None
    assert order(rank(blind, sighted))[0] == "blind"  # Severe miles decide before average risk


def test_no_forecast_miles_do_not_enter_the_ranking_steps():
    half_blind = route("half", [L, L, None, None], minutes=900)
    full = route("full", [L, L, L, L], minutes=300)

    assert order(rank(half_blind, full)) == ["full", "half"]
    assert rank(half_blind, full).decided_by is RankingStep.TRAVEL_TIME


def test_time_then_miles_then_id_break_ties():
    a = route("a", [L, L], minutes=600, total=100)
    b = route("b", [L, L], minutes=500, total=120)
    assert order(rank(a, b)) == ["b", "a"]

    c = route("c", [L, L], minutes=500, total=90)
    ranking = rank(b, c)
    assert order(ranking) == ["c", "b"]
    assert ranking.decided_by is RankingStep.MILES

    d = route("d", [L, L], minutes=500, total=90)
    ranking = rank(d, c)
    assert order(ranking) == ["c", "d"]
    assert ranking.decided_by is RankingStep.ROUTE_ID
    assert ranking.routes[1].vs_first.dropped_at is RankingStep.ROUTE_ID


def test_second_and_third_place_repeat_the_steps_without_the_winner():
    best = route("best", [L, L, L, L], minutes=900)
    middle = route("middle", [L, S, L, L], minutes=500)
    worst = route("worst", [L, S, S, L], minutes=100)

    ranking = rank(worst, best, middle)

    assert order(ranking) == ["best", "middle", "worst"]
    assert [r.rank for r in ranking.routes] == [1, 2, 3]
    assert ranking.routes[2].vs_first.dropped_at is RankingStep.SEVERE


def test_second_place_can_come_from_a_different_step_than_first():
    # Against the winner both lose on Severe; between themselves the faster of the two ranks 2nd.
    best = route("best", [L, L, L, L], minutes=900)
    slow = route("slow", [L, S, L, L], minutes=800)
    fast = route("fast", [L, S, L, L], minutes=300)

    assert order(rank(slow, fast, best)) == ["best", "fast", "slow"]


def test_comparison_gives_the_trade_each_other_route_makes():
    safe = route("safe", [L, L, L, L], minutes=600)
    risky = route("risky", [L, S, H, L], minutes=300)

    ranking = rank(safe, risky)
    comparison = ranking.routes[1].vs_first

    assert comparison.travel_time_seconds == -300 * 60
    assert comparison.severe_miles == 25
    assert comparison.high_miles == 25
    assert comparison.no_travel_miles == 0
    assert comparison.average_risk == pytest.approx(1.25)
    assert ranking.routes[0].vs_first is None


@pytest.mark.parametrize("count", [2, 3])
def test_result_is_the_same_in_every_input_order(count):
    routes = [
        route("r1", [L, L, M, L], minutes=500),
        route("r2", [L, H, H, L], minutes=300),
        route("r3", [L, S, L, L], minutes=100),
    ][:count]

    results = {rank_routes(list(p), INTERVAL) for p in itertools.permutations(routes)}

    assert len(results) == 1


def test_result_is_order_independent_with_ties_everywhere():
    routes = [route(i, [L, L], minutes=600, total=100) for i in ("x", "y", "z")]

    results = {rank_routes(list(p), INTERVAL) for p in itertools.permutations(routes)}

    assert len(results) == 1
    assert order(next(iter(results))) == ["x", "y", "z"]


@pytest.mark.parametrize("count", [0, 1, 4])
def test_fewer_than_two_or_more_than_three_routes_are_rejected(count):
    routes = [route(f"r{i}", [L, L]) for i in range(count)]
    with pytest.raises(ValueError):
        rank_routes(routes, INTERVAL)


def test_duplicate_ids_and_bad_inputs_are_rejected():
    a = route("a", [L, L])
    with pytest.raises(ValueError):
        rank_routes([a, a], INTERVAL)
    with pytest.raises(ValueError):
        rank_routes([a, route("b", [L, L])], 0)
    with pytest.raises(ValueError):
        rank_routes([a, route("b", [L, L], minutes=float("nan"))], INTERVAL)
