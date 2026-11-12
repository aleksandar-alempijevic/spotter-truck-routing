"""Q2/Q3/Q4: identity check precip = rain+showers+snow/7, model resolution, horizon/nulls, forecast_hours, preceding-hour semantics."""
import json, statistics as st
from common import get, PTS
# --- Q3 identity on every snowy/rainy hour at snow points
names = ["Donner Pass CA", "Teton Pass WY", "Marquette MI", "Buffalo NY", "Anchorage AK", "Snoqualmie WA"]
d, _ = get({"latitude": ",".join(str(PTS[n][0]) for n in names), "longitude": ",".join(str(PTS[n][1]) for n in names),
            "hourly": "precipitation,rain,showers,snowfall", "precipitation_unit": "inch", "timezone": "UTC", "forecast_days": 4})
res = []; mixed = 0; n = 0
for loc in d:
    h = loc["hourly"]
    for i in range(len(h["time"])):
        p, r, s, sn = h["precipitation"][i], h["rain"][i], h["showers"][i], h["snowfall"][i]
        if p and p > 0.01:
            n += 1; res.append(p - r - s - sn / 7)
print(f"Q3 identity: {n} wet hours, residual precip-rain-showers-snow/7: min {min(res):.4f} max {max(res):.4f} mean {st.mean(res):.5f}")
# --- Q2: model resolution at a CONUS point (Denver) by comparing best_match with named models
pt = {"latitude": 39.74, "longitude": -104.99, "hourly": "wind_speed_10m,wind_gusts_10m,precipitation,temperature_2m",
      "wind_speed_unit": "mph", "precipitation_unit": "inch", "timezone": "UTC", "forecast_hours": 96}
bm, hdr = get(pt)
print("forecast_hours=96 ->", len(bm["hourly"]["time"]), bm["hourly"]["time"][0], bm["hourly"]["time"][-1])
for k in ("wind_speed_10m", "wind_gusts_10m", "precipitation"):
    v = bm["hourly"][k]; print(k, "nulls:", sum(x is None for x in v), "of", len(v))
for m in ["ncep_hrrr_conus", "ncep_nbm_conus", "ncep_nam_conus", "ncep_gfs013", "gfs_seamless", "ecmwf_ifs025", "icon_seamless", "gem_seamless", "ukmo_seamless", "meteofrance_seamless"]:
    try:
        o, _ = get(dict(pt, models=m))
    except Exception as e:
        print(m, "ERR", e); continue
    row = []
    for k in ("wind_speed_10m", "temperature_2m"):
        a, b = bm["hourly"][k], o["hourly"][k + ""]
        pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
        exact = sum(1 for x, y in pairs if x == y)
        first_null = next((i for i, y in enumerate(b) if y is None), None)
        row.append(f"{k}: exact {exact}/{len(a)} nulls_from={first_null}")
    print(f"{m:16s}", " | ".join(row))
# --- Q4: hourly precipitation vs minutely_15 sums (preceding vs following hour)
mq, _ = get({"latitude": 47.42, "longitude": -121.41, "hourly": "precipitation,snowfall,wind_speed_10m,wind_gusts_10m", "minutely_15": "precipitation,snowfall,wind_speed_10m,wind_gusts_10m",
             "precipitation_unit": "inch", "wind_speed_unit": "mph", "timezone": "UTC", "forecast_days": 2})
m15 = mq["minutely_15"]; hr = mq["hourly"]
idx = {t: i for i, t in enumerate(m15["time"])}
import datetime as dt
def f(t): return dt.datetime.fromisoformat(t)
prec = fol = ok_prec = ok_fol = used = 0
gprec = gfol = 0
for i, t in enumerate(hr["time"]):
    T = f(t)
    if hr["precipitation"][i] is None or hr["precipitation"][i] < 0.005: continue
    def s(off_start):
        tot = 0; 
        for k in range(4):
            tt = (T + dt.timedelta(minutes=off_start + 15 * k)).strftime("%Y-%m-%dT%H:%M")
            if tt not in idx: return None
            tot += m15["precipitation"][idx[tt]] or 0
        return tot
    a, b = s(-60), s(0)
    if a is None or b is None: continue
    used += 1
    ok_prec += abs(a - hr["precipitation"][i]) < 0.0015; ok_fol += abs(b - hr["precipitation"][i]) < 0.0015
print(f"Q4 precip: {used} wet hours; hourly == sum of 4 quarter-hours ending at T: {ok_prec}; starting at T: {ok_fol}")
# wind: instantaneous? compare hourly wind at T with m15 at T and at T-45..T
mt = sum(1 for i, t in enumerate(hr["time"]) if t in idx and hr["wind_speed_10m"][i] == m15["wind_speed_10m"][idx[t]])
print("Q4 wind: hourly == 15-min value stamped T:", mt, "of", len(hr["time"]))
gm = sum(1 for i, t in enumerate(hr["time"]) if t in idx and hr["wind_gusts_10m"][i] is not None and
         abs(hr["wind_gusts_10m"][i] - max((m15["wind_gusts_10m"][idx[(f(t) - dt.timedelta(minutes=15 * k)).strftime("%Y-%m-%dT%H:%M")]] or 0) for k in range(4) if (f(t) - dt.timedelta(minutes=15 * k)).strftime("%Y-%m-%dT%H:%M") in idx)) < 0.06)
print("Q4 gust: hourly == max of 4 quarter-hours ending at T:", gm, "of", len(hr["time"]))
