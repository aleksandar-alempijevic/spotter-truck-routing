"""Q4: hourly precipitation/snowfall vs minutely_15 (preceding vs following hour); wind instantaneous check."""
import datetime as dt
from common import get, PTS
names = ["Donner Pass CA", "Marquette MI", "Teton Pass WY", "Snoqualmie WA", "Buffalo NY", "Anchorage AK"]
d, _ = get({"latitude": ",".join(str(PTS[n][0]) for n in names), "longitude": ",".join(str(PTS[n][1]) for n in names),
            "hourly": "precipitation,snowfall,wind_speed_10m", "minutely_15": "precipitation,snowfall,wind_speed_10m",
            "precipitation_unit": "inch", "wind_speed_unit": "mph", "timezone": "UTC", "forecast_days": 3})
F = lambda t: dt.datetime.fromisoformat(t)
S = lambda x: x.strftime("%Y-%m-%dT%H:%M")
res = {"prec_end": 0, "prec_start": 0, "snow_end": 0, "snow_start": 0, "n": 0, "wind_eq_T": 0, "wind_n": 0}
for loc in d:
    m, h = loc["minutely_15"], loc["hourly"]; idx = {t: i for i, t in enumerate(m["time"])}
    for i, t in enumerate(h["time"]):
        T = F(t)
        for key, tag in (("precipitation", "prec"), ("snowfall", "snow")):
            v = h[key][i]
            if v is None or v < 0.01: continue
            def tot(start):
                ts = [S(T + dt.timedelta(minutes=start + 15 * k)) for k in range(4)]
                return None if any(x not in idx for x in ts) else sum(m[key][idx[x]] or 0 for x in ts)
            a, b = tot(-60), tot(0)
            if a is None or b is None: continue
            if tag == "prec": res["n"] += 1
            res[tag + "_end"] += abs(a - v) < 0.0025; res[tag + "_start"] += abs(b - v) < 0.0025
        if t in idx and h["wind_speed_10m"][i] is not None:
            res["wind_n"] += 1; res["wind_eq_T"] += abs(h["wind_speed_10m"][i] - m["wind_speed_10m"][idx[t]]) < 0.06
print(res)
