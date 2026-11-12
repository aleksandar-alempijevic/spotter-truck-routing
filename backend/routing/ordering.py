"""Deterministic route order and ids."""

from collections.abc import Sequence

from .route import Route


def order_routes(routes: Sequence[Route]) -> list[tuple[str, Route]]:
    """Routes by travel time, then miles, each with an id numbered from that order.

    Ids are assigned from the sorted order, so they are unique and the same routes always get the
    same ids whatever order the provider returned them in.
    """
    ordered = sorted(routes, key=lambda r: (r.travel_time_s, r.length_m))
    return [(f"route-{n}", route) for n, route in enumerate(ordered, start=1)]
