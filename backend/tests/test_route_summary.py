import dataclasses

import pytest

from risk_rules import Checkpoint, Level, RouteSummary, summarize_route

L, M, H, S, N = Level.LOW, Level.MODERATE, Level.HIGH, Level.SEVERE, Level.NO_TRAVEL


def test_each_checkpoint_stands_for_the_road_up_to_the_next_and_the_last_to_the_end():
    summary = summarize_route(
        100, [Checkpoint(0, L), Checkpoint(25, M), Checkpoint(50, H), Checkpoint(75, S)]
    )

    assert summary.miles_by_level == {L: 25, M: 25, H: 25, S: 25, N: 0}
    assert (summary.severe_miles, summary.high_miles, summary.no_travel_miles) == (25, 25, 0)
    assert summary.no_forecast_miles == 0
    assert summary.forecast_miles == 100


def test_average_risk_is_weighted_by_miles_not_by_checkpoints():
    summary = summarize_route(100, [Checkpoint(0, L), Checkpoint(90, S)])

    assert summary.average_risk == pytest.approx(0.3)


def test_no_travel_scores_four_in_the_average():
    summary = summarize_route(50, [Checkpoint(0, L), Checkpoint(25, N)])

    assert summary.average_risk == pytest.approx(2.0)


def test_miles_without_a_forecast_are_counted_apart_and_never_as_low():
    summary = summarize_route(100, [Checkpoint(0, S), Checkpoint(50, None)])

    assert summary.miles_by_level[L] == 0
    assert summary.no_forecast_miles == 50
    assert summary.average_risk == pytest.approx(3.0)
    assert summary.forecast_miles == 50


def test_route_with_no_forecast_at_all_has_no_average_risk():
    summary = summarize_route(40, [Checkpoint(0, None), Checkpoint(20, None)])

    assert summary.average_risk is None
    assert summary.no_forecast_miles == 40
    assert summary.forecast_miles == 0


def test_checkpoint_at_the_destination_stands_for_no_miles():
    summary = summarize_route(50, [Checkpoint(0, L), Checkpoint(25, L), Checkpoint(50, N)])

    assert summary.no_travel_miles == 0
    assert summary.miles_by_level[L] == 50
    assert summary.forecast_miles == 50


def test_single_checkpoint_covers_the_whole_route():
    assert summarize_route(12.5, [Checkpoint(0, H)]).high_miles == 12.5


@pytest.mark.parametrize(
    ("total", "checkpoints"),
    [
        (50, []),
        (50, [Checkpoint(5, L)]),  # road before the first checkpoint
        (50, [Checkpoint(0, L), Checkpoint(30, L), Checkpoint(20, L)]),  # not ascending
        (50, [Checkpoint(0, L), Checkpoint(25, L), Checkpoint(25, L)]),  # duplicate mark
        (50, [Checkpoint(0, L), Checkpoint(60, L)]),  # beyond the end
        (float("nan"), [Checkpoint(0, L)]),
        (-1, [Checkpoint(0, L)]),
        (50, [Checkpoint(0, L), Checkpoint(float("inf"), L)]),
    ],
)
def test_contract_violations_are_rejected(total, checkpoints):
    with pytest.raises(ValueError):
        summarize_route(total, checkpoints)


def test_miles_by_level_is_read_only_and_covers_every_level():
    summary = summarize_route(50, [Checkpoint(0, L), Checkpoint(25, S)])

    assert list(summary.miles_by_level) == list(Level)
    with pytest.raises(TypeError):
        summary.miles_by_level[L] = 0  # type: ignore[index]
    with pytest.raises(dataclasses.FrozenInstanceError):
        summary.low_miles = 0  # type: ignore[misc]


def test_summary_is_hashable_and_equal_by_value():
    one = summarize_route(50, [Checkpoint(0, L), Checkpoint(25, S)])
    two = summarize_route(50, [Checkpoint(0, L), Checkpoint(25, S)])

    assert one == two
    assert hash(one) == hash(two)


def summary_fields(**changes):
    fields = {
        "low_miles": 10.0,
        "moderate_miles": 10.0,
        "high_miles": 0.0,
        "severe_miles": 0.0,
        "no_travel_miles": 0.0,
        "no_forecast_miles": 0.0,
        "average_risk": 0.5,
    }
    return {**fields, **changes}


def test_summary_accepts_consistent_fields():
    assert RouteSummary(**summary_fields()).forecast_miles == 20


@pytest.mark.parametrize(
    "changes",
    [
        {"high_miles": -1.0},
        {"no_forecast_miles": float("nan")},
        {"severe_miles": float("inf")},
        {"average_risk": None},  # forecasted miles but no average
        {"average_risk": 1.5},  # does not match the miles
        {"low_miles": 0.0, "moderate_miles": 0.0},  # average present without forecasted miles
    ],
)
def test_summary_rejects_inconsistent_fields(changes):
    with pytest.raises(ValueError):
        RouteSummary(**summary_fields(**changes))


def test_summary_without_forecasted_miles_has_no_average():
    empty = summary_fields(
        low_miles=0.0, moderate_miles=0.0, average_risk=None, no_forecast_miles=5
    )

    assert RouteSummary(**empty).average_risk is None
