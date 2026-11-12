"""Synthetic routes and TomTom response bodies for tests."""

from routing import Point, Route, haversine_m


def lerp(a: Point, b: Point, steps: int) -> list[Point]:
    return [
        (a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps)
        for i in range(steps + 1)
    ]


def path(waypoints: list[Point], steps_per_leg: int = 60) -> list[list[Point]]:
    """Points per leg along straight lines between the waypoints."""
    return [lerp(a, b, steps_per_leg) for a, b in zip(waypoints, waypoints[1:], strict=False)]


def tomtom_route(waypoints: list[Point], speed_mps: float = 25.0, every: int = 20) -> dict:
    """One TomTom route object: legs of points, coded instructions and a summary.

    Instruction offsets and times are cumulative over the whole route, across legs.
    """
    legs = path(waypoints)
    flat = [p for leg in legs for p in leg]
    cumulative = [0.0]
    for a, b in zip(flat, flat[1:], strict=False):
        cumulative.append(cumulative[-1] + haversine_m(a, b))
    indexes = list(range(0, len(flat), every))
    if indexes[-1] != len(flat) - 1:
        indexes.append(len(flat) - 1)
    instructions = [
        {
            "pointIndex": i,
            "routeOffsetInMeters": round(cumulative[i]),
            "travelTimeInSeconds": round(cumulative[i] / speed_mps),
        }
        for i in indexes
    ]
    length = round(cumulative[-1])
    return {
        "summary": {"lengthInMeters": length, "travelTimeInSeconds": round(length / speed_mps)},
        "legs": [
            {"points": [{"latitude": lat, "longitude": lon} for lat, lon in leg]} for leg in legs
        ],
        "guidance": {"instructions": instructions},
    }


def tomtom_body(*routes: dict) -> dict:
    return {"formatVersion": "0.0.12", "routes": list(routes)}


def route_from(waypoints: list[Point], **kwargs) -> Route:
    """A `routing.Route` built the way the TomTom adapter builds one."""
    from providers.tomtom import _parse_route

    return _parse_route(tomtom_route(waypoints, **kwargs), None)
