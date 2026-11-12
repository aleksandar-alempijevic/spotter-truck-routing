"""Q1: GET URL length limit via a 1-location request padded with a junk param (cost 1 each)."""
import urllib.request, urllib.error
BASE = "https://api.open-meteo.com/v1/forecast?latitude=39.74&longitude=-104.99&hourly=precipitation&forecast_days=1&pad="
def ok(total):
    pad = "a" * (total - len(BASE))
    try:
        urllib.request.urlopen(urllib.request.Request(BASE + pad, headers={"User-Agent": "spotter-spike"}), timeout=30).read(); return 200
    except urllib.error.HTTPError as e: return e.code
lo, hi = 5361, 10544
print(ok(lo), ok(hi))
while hi - lo > 64:
    mid = (lo + hi) // 2
    c = ok(mid); print(mid, c, flush=True)
    if c == 414: hi = mid
    else: lo = mid
print("limit between", lo, hi)
