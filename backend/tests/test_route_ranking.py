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
    return RouteCandidate(route_id, minutes * 60.0, summarize_route(total, marks))


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
    a = RouteCandidate("a", 3000.0, summarize_route(total, marks_a))
    b = RouteCandidate("b", 1000.0, summarize_route(total, marks_b))

    ranking = rank_routes([a, b], interval)

    assert order(ranking) == ["b", "a"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_high_gap_a_little_over_one_interval_is_not_a_tie():
    # "b" has 0.101 High miles against "a"'s 0, beyond one 0.1-mile interval plus the float
    # margin. It is riskier on average too, but the High step comes first, so it drops there.
    interval = 0.1
    marks_a = [Checkpoint(sum([0.1] * i), M if i in (1, 2) else L) for i in range(11)]
    a = RouteCandidate("a", 3000.0, summarize_route(1.1, marks_a))
    marks_b = [Checkpoint(0, M), Checkpoint(0.2, L), Checkpoint(0.5, H), Checkpoint(0.601, L)]
    b = RouteCandidate("b", 1000.0, summarize_route(1.1, marks_b))

    ranking = rank_routes([a, b], interval)

    assert order(ranking) == ["a", "b"]
    assert ranking.decided_by is RankingStep.HIGH
    assert ranking.routes[1].vs_first.dropped_at is RankingStep.HIGH


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


def two_routes(**changes):
    a = route("a", [L, L], **changes)
    return [a, route("b", [L, L])]


@pytest.mark.parametrize(
    ("candidates", "interval"),
    [
        ([], INTERVAL),
        ([route("a", [L, L])], INTERVAL),
        ([route(f"r{i}", [L, L]) for i in range(4)], INTERVAL),
        ([route("a", [L, L]), route("a", [L, L])], INTERVAL),
        (two_routes(minutes=-1), INTERVAL),
        (two_routes(minutes=float("nan")), INTERVAL),
        (two_routes(minutes=float("inf")), INTERVAL),
        (two_routes(), 0),
        (two_routes(), -25),
        (two_routes(), float("nan")),
        (two_routes(), float("inf")),
    ],
    ids=[
        "no routes",
        "one route",
        "four routes",
        "duplicate id",
        "negative time",
        "nan time",
        "infinite time",
        "zero interval",
        "negative interval",
        "nan interval",
        "infinite interval",
    ],
)
def test_invalid_ranking_inputs_are_rejected(candidates, interval):
    with pytest.raises(ValueError):
        rank_routes(candidates, interval)


def marked_route(route_id, marks, total, minutes=600):
    """A route from explicit (mile, level) marks, for float-edge cases."""
    checkpoints = [Checkpoint(mile, level) for mile, level in marks]
    return RouteCandidate(route_id, minutes * 60.0, summarize_route(total, checkpoints))


def test_average_risk_gap_beyond_the_tolerance_decides():
    steady = route("steady", [L] * 4, minutes=900)
    two_moderate = route("two", [M, M, L, L], minutes=300)  # average 0.5 > 25 / 100

    ranking = rank(steady, two_moderate)

    assert order(ranking) == ["steady", "two"]
    assert ranking.decided_by is RankingStep.AVERAGE_RISK


def test_average_risk_gap_of_exactly_the_tolerance_is_a_tie():
    steady = route("steady", [L] * 4, minutes=900)
    one_moderate = route("one", [M, L, L, L], minutes=300)  # average 0.25 == 25 / 100

    assert order(rank(steady, one_moderate)) == ["one", "steady"]


def test_average_risk_gap_below_the_tolerance_on_a_short_last_segment_falls_through_to_time():
    # 7 full checkpoints and a 10-mile last one: 185 forecast miles, tolerance 25 / 185.
    steady = route("steady", [L] * 8, minutes=900, total=185)
    short_moderate = route("short", [L] * 7 + [M], minutes=300, total=185)  # 10 / 185

    ranking = rank(steady, short_moderate)

    assert order(ranking) == ["short", "steady"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_one_level_step_at_one_checkpoint_ties_when_the_length_is_not_a_multiple_of_the_interval():
    # 1010 miles at 25-mile spacing: 41 checkpoints, the last standing for 10 miles. Moderate
    # against High at one full-interval checkpoint is a gap of exactly 25 / 1010.
    levels_a = [L] * 41
    levels_a[3] = M
    levels_b = [L] * 41
    levels_b[3] = H
    slower = route("slower", levels_a, minutes=900, total=1010)
    faster = route("faster", levels_b, minutes=300, total=1010)

    ranking = rank(slower, faster)

    assert order(ranking) == ["faster", "slower"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_two_levels_at_one_checkpoint_exceed_the_tolerance_at_1010_miles():
    levels_a = [L] * 41
    levels_b = [L] * 41
    levels_b[3] = M
    levels_b[4] = M
    slower = route("slower", levels_a, minutes=900, total=1010)
    faster = route("faster", levels_b, minutes=300, total=1010)

    ranking = rank(slower, faster)

    assert order(ranking) == ["slower", "faster"]
    assert ranking.decided_by is RankingStep.AVERAGE_RISK


def test_each_route_has_its_own_tolerance_from_its_own_length():
    # Tolerance is 25 / 100 for the short route and 25 / 1010 for the long one, and a route is
    # judged by its own. The long route's average of 0.099 is not within 25 / 1010 of the short
    # route's 0, so the long route loses even though it is faster.
    short = route("short", [L] * 4, minutes=900)
    levels = [L] * 41
    levels[1:5] = [M] * 4
    long_route = route("long", levels, minutes=300, total=1010)

    ranking = rank(short, long_route)

    assert order(ranking) == ["short", "long"]
    assert ranking.decided_by is RankingStep.AVERAGE_RISK


def test_unrelated_route_length_and_coverage_leave_the_other_two_unchanged():
    slow_clean = route("a", [L] * 40, minutes=900)
    fast_moderate = route("b", [M] * 20 + [L] * 20, minutes=300)  # 500 Moderate miles
    # Forecast for the first 50 miles only, then nothing: a wide tolerance of its own.
    mostly_blind = route("c", [L, L] + [None] * 38, minutes=1200)

    pair = rank(slow_clean, fast_moderate)
    trio = rank(slow_clean, fast_moderate, mostly_blind)

    assert order(pair) == ["a", "b"]
    assert pair.decided_by is RankingStep.AVERAGE_RISK
    assert order(trio)[0] == "a"
    assert order(trio).index("a") < order(trio).index("b")
    assert trio.decided_by is RankingStep.TRAVEL_TIME
    b_in_trio = next(r for r in trio.routes if r.route_id == "b")
    assert b_in_trio.vs_first.dropped_at is RankingStep.AVERAGE_RISK


def three_500_mile_routes():
    # 20 checkpoints at 25 miles. Average risk: a 0, b 0.05, c 0.10; each tolerance is 0.05.
    a = route("a", [L] * 20, minutes=900)
    b = route("b", [M] + [L] * 19, minutes=600)
    c = route("c", [M, M] + [L] * 18, minutes=300)
    return a, b, c


def test_ties_are_against_the_best_route_in_contention_so_a_third_route_can_change_the_winner():
    a, b, c = three_500_mile_routes()

    pair = rank(b, c)
    trio = rank(a, b, c)

    # b and c are one level of one checkpoint apart: a tie, and the faster c wins on time.
    assert order(pair) == ["c", "b"]
    assert pair.decided_by is RankingStep.TRAVEL_TIME
    # With a all Low in the contest, c is two checkpoint-levels above the best and drops, but b
    # is one level above it and stays, so b wins.
    assert order(trio) == ["b", "a", "c"]
    assert trio.decided_by is RankingStep.TRAVEL_TIME
    assert trio.routes[2].vs_first.dropped_at is RankingStep.AVERAGE_RISK


def test_a_dropped_route_reports_what_it_was_measured_against_at_its_step():
    a, b, c = three_500_mile_routes()

    trio = rank(a, b, c)

    dropped_c = trio.routes[2].vs_first
    assert dropped_c.dropped_against.best_route_id == "a"  # the step's best, not the winner b
    assert dropped_c.dropped_against.route_value == pytest.approx(0.1)
    assert dropped_c.dropped_against.best_value == 0
    assert dropped_c.dropped_against.tolerance == pytest.approx(0.05)
    dropped_a = trio.routes[1].vs_first
    assert dropped_a.dropped_at is RankingStep.TRAVEL_TIME
    assert dropped_a.dropped_against.best_route_id == "b"
    assert dropped_a.dropped_against.route_value == 900 * 60
    assert dropped_a.dropped_against.best_value == 600 * 60


def test_route_id_drop_is_measured_against_the_winner():
    x, y = route("x", [L, L], total=100), route("y", [L, L], total=100)

    dropped = rank(x, y).routes[1].vs_first

    assert dropped.dropped_at is RankingStep.ROUTE_ID
    assert dropped.dropped_against.best_route_id == "x"
    assert dropped.dropped_against.route_value is None


def test_dropping_for_having_no_average_risk_reports_no_value():
    blind = route("blind", [None] * 4)
    sighted = route("sighted", [L] * 4)

    dropped = rank(blind, sighted).routes[1].vs_first

    assert dropped.dropped_at is RankingStep.AVERAGE_RISK
    assert dropped.dropped_against.best_route_id == "sighted"
    assert dropped.dropped_against.route_value is None
    assert dropped.dropped_against.best_value == 0


def test_average_risk_tolerance_is_capped_at_one_level():
    # 20 forecast miles at a 50-mile interval would give a tolerance of 2.5 levels, which would
    # tie an all-High route with an all-Low one. The cap of 1 level makes the all-High route lose.
    clear = route("clear", [L, L], minutes=900, interval=10)
    high = route("high", [H, H], minutes=300, interval=10)

    ranking = rank_routes([clear, high], 50)

    assert order(ranking) == ["clear", "high"]
    assert ranking.decided_by is RankingStep.AVERAGE_RISK
    assert ranking.routes[1].vs_first.dropped_against.tolerance == 1.0


def test_tolerance_uses_forecast_miles_not_total_miles():
    # "partly" has a forecast for 100 of its 1000 miles. Its average of 0.25 is one level on one
    # 25-mile checkpoint, which is within its tolerance of 25 / 100 of the all-Low route. Judged
    # by total miles (25 / 1000) it would lose at average risk.
    clear = route("clear", [L] * 40, minutes=900)
    partly = route("partly", [L, M, L, L] + [None] * 36, minutes=300)

    ranking = rank(clear, partly)

    assert partly.total_miles == 1000
    assert order(ranking) == ["partly", "clear"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_one_high_checkpoint_survives_the_high_step_but_loses_at_average_risk():
    # High against Low is two levels; the tolerance absorbs one.
    clear = route("clear", [L] * 4, minutes=900)
    one_high = route("one_high", [H, L, L, L], minutes=300)

    ranking = rank(clear, one_high)

    assert order(ranking) == ["clear", "one_high"]
    assert ranking.decided_by is RankingStep.AVERAGE_RISK
    assert ranking.routes[1].vs_first.dropped_at is RankingStep.AVERAGE_RISK


def test_candidate_length_is_derived_from_its_summary():
    candidate = route("x", [L, None, L], total=80)

    assert candidate.total_miles == pytest.approx(80)
    with pytest.raises(TypeError):
        RouteCandidate("x", 1.0, 80.0, candidate.summary)  # type: ignore[call-arg]


def test_average_risk_edge_with_float_noise_in_the_marks_is_a_tie():
    # Marks accumulated by repeated addition carry rounding error. The one-level gap here is
    # 5.5e-17 above the tolerance in floating point, and equal to it on paper.
    interval = 0.1
    positions = []
    position = 0.0
    for _ in range(5):
        positions.append(position)
        position += interval
    total = position + interval * 0.4
    flat = marked_route("flat", [(p, L) for p in positions], total, minutes=900)
    levels = [M if i == 2 else L for i in range(5)]
    bumped = marked_route("bumped", list(zip(positions, levels, strict=True)), total, minutes=300)
    raw_gap = bumped.summary.average_risk - flat.summary.average_risk
    assert raw_gap > interval / flat.summary.forecast_miles  # on the wrong side by noise alone

    ranking = rank_routes([flat, bumped], interval)

    assert order(ranking) == ["bumped", "flat"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_a_route_eliminated_earlier_does_not_rescue_a_route_at_average_risk():
    # The short Severe route has a wide tolerance of its own (25 / 50) but is out at the Severe
    # step, and tolerances are per route, so "two" still loses to "flat" at average risk.
    flat = route("flat", [L] * 8, minutes=900)
    two_moderate = route("two", [M, M] + [L] * 6, minutes=300)  # average 0.25 > 0.125
    severe_short = route("severe", [L, S], minutes=100)

    ranking = rank(severe_short, two_moderate, flat)

    assert order(ranking) == ["flat", "two", "severe"]
    assert ranking.decided_by is RankingStep.AVERAGE_RISK
    assert ranking.routes[2].vs_first.dropped_at is RankingStep.SEVERE
    assert ranking.routes[1].vs_first.dropped_at is RankingStep.AVERAGE_RISK


def test_route_without_forecast_drops_at_average_risk_while_the_others_tie_on_it():
    blind = route("blind", [None] * 4, minutes=100)
    slow = route("slow", [L] * 4, minutes=900)
    fast = route("fast", [M, L, L, L], minutes=300)  # average 0.25 == 25 / 100: a tie

    ranking = rank(blind, slow, fast)

    assert order(ranking) == ["fast", "slow", "blind"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME
    assert ranking.routes[2].vs_first.dropped_at is RankingStep.AVERAGE_RISK
    assert ranking.routes[2].vs_first.average_risk is None
    assert ranking.routes[2].no_forecast_miles == 100


def test_when_no_route_has_an_average_risk_the_step_is_skipped_and_time_decides():
    slow = route("slow", [None] * 4, minutes=900)
    fast = route("fast", [None] * 4, minutes=300)

    ranking = rank(slow, fast)

    assert order(ranking) == ["fast", "slow"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME
    assert ranking.routes[1].vs_first.average_risk is None


SUB_MARGIN = 1e-9
ABOVE_MARGIN = 1e-3


def severe_gap_route(route_id, gap, minutes):
    """100 miles with `25 + gap` Severe miles, then Low."""
    return marked_route(route_id, [(0, L), (25, S), (50 + gap, L)], 100, minutes)


def test_severe_gap_below_the_float_margin_is_a_tie_and_time_decides():
    ranking = rank(severe_gap_route("a", 0, 900), severe_gap_route("b", SUB_MARGIN, 300))

    assert order(ranking) == ["b", "a"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_severe_gap_above_the_float_margin_decides():
    ranking = rank(severe_gap_route("a", 0, 900), severe_gap_route("b", ABOVE_MARGIN, 300))

    assert order(ranking) == ["a", "b"]
    assert ranking.decided_by is RankingStep.SEVERE


def no_travel_gap_route(route_id, miles, minutes):
    return marked_route(route_id, [(0, L), (100 - miles, N)], 100, minutes)


def test_no_travel_gap_below_the_float_margin_is_a_tie_and_time_decides():
    ranking = rank(
        no_travel_gap_route("a", SUB_MARGIN, 900), no_travel_gap_route("b", 2 * SUB_MARGIN, 300)
    )

    assert order(ranking) == ["b", "a"]
    assert ranking.decided_by is RankingStep.TRAVEL_TIME


def test_no_travel_gap_above_the_float_margin_decides():
    ranking = rank(
        no_travel_gap_route("a", ABOVE_MARGIN, 900), no_travel_gap_route("b", 2 * ABOVE_MARGIN, 300)
    )

    assert order(ranking) == ["a", "b"]
    assert ranking.decided_by is RankingStep.NO_TRAVEL


def test_sub_margin_no_travel_miles_do_not_stop_a_route_being_recommended():
    nearly_clear = no_travel_gap_route("a", SUB_MARGIN, 300)
    clear = route("b", [L] * 4, minutes=900)

    ranking = rank(nearly_clear, clear)

    assert ranking.recommended_id == "a"


def test_no_travel_miles_above_the_float_margin_leave_nothing_recommended():
    ranking = rank(no_travel_gap_route("a", ABOVE_MARGIN, 300), no_travel_gap_route("b", 1, 900))

    assert ranking.recommended_id is None
