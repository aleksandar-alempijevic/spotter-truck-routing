"""Q3: find snowy hours, relate snowfall (in) to precipitation (in), compare with raw mm/cm units."""
from common import *
import json
names = list(PTS)
p = {"latitude": ",".join(str(PTS[n][0]) for n in names), "longitude": ",".join(str(PTS[n][1]) for n in names),
     "hourly": "precipitation,snowfall,rain,showers,temperature_2m", "precipitation_unit": "inch", "timezone": "UTC", "forecast_days": 4}
inch, _ = get(p)
p2 = dict(p); p2.pop("precipitation_unit")  # default mm / cm
raw, _ = get(p2)
rows = []
for n, a, b in zip(names, inch, raw):
    h, r = a["hourly"], b["hourly"]
    tot_s = sum(x or 0 for x in h["snowfall"]); tot_p = sum(x or 0 for x in h["precipitation"])
    print(f"{n:18s} snow_in_sum={tot_s:6.2f} precip_in_sum={tot_p:6.3f} units={a['hourly_units']['snowfall']},{b['hourly_units']['snowfall']},{b['hourly_units']['precipitation']}")
    for i, t in enumerate(h["time"]):
        s, pr = h["snowfall"][i], h["precipitation"][i]
        if s and s > 0:
            rows.append((n, t, s, pr, h["rain"][i], h["showers"][i], h["temperature_2m"][i], r["snowfall"][i], r["precipitation"][i]))
print(len(rows), "snowy hours")
# ratio snowfall_cm / precipitation_mm for snowy hours where rain==0 (pure snow)
ratios = [r[7] / r[8] for r in rows if r[8] and r[4] == 0 and r[8] > 0.2]
print("pure-snow hours:", len(ratios), "cm/mm ratio min/median/max:", min(ratios), sorted(ratios)[len(ratios)//2], max(ratios)) if ratios else None
for r in rows[:12]: print(r)
json.dump(rows, open("/dev/null", "w"))
