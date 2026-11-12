import asyncio
import gc

import pytest

from api import planner
from providers.errors import ProviderUnavailable
from routing.via_cities import CITIES
from tests.route_fixtures import route_from

LA, NY, DENVER = CITIES["Los Angeles"], CITIES["New York"], CITIES["Denver"]
SOUTH = [LA, CITIES["Albuquerque"], NY]


@pytest.mark.parametrize("attempt", range(8))
async def test_failures_of_calls_skipped_once_the_gap_is_filled_are_not_left_unretrieved(attempt):
    unretrieved = []
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(lambda loop, context: unretrieved.append(context))
    base = [route_from([LA, DENVER, NY]), route_from([LA, CITIES["Salt Lake City"], NY])]
    winner = route_from(SOUTH)

    async def route_call(via, alternatives):
        # Every call finishes at once: one answers with a distinct route, the rest fail, so some
        # failures land in the same batch as the call that fills the gap.
        if via.name == "Albuquerque":
            return [winner]
        raise ProviderUnavailable

    routes, shortfall = await planner._fill(base, route_call, LA, NY, loop.time() + 30)
    del route_call
    gc.collect()
    await asyncio.sleep(0)

    assert shortfall is None
    assert winner in routes
    assert unretrieved == []
