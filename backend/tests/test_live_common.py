import httpx

from live_common import LocationMeter
from providers.outbound import Outbound

URL = "https://api.open-meteo.com/v1/forecast"


async def test_the_meter_wraps_the_send_the_outbound_makes_and_records_the_post(provider_mock):
    provider_mock.route(host="api.open-meteo.com").mock(return_value=httpx.Response(200, json={}))

    with LocationMeter(budget=10) as meter:
        async with Outbound() as outbound:
            await outbound.post_form(URL, {"latitude": "1.0,2.0,3.0"}, timeout=5)
            await outbound.get_json(URL, {}, timeout=5)

    assert meter.spent == 3
    assert [r["status"] for r in meter.records] == [200]
