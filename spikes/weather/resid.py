"""Q3: inspect residual of precip - rain - showers - snow/7 in raw mm/cm and inches."""
from common import get, PTS
names = ["Donner Pass CA", "Teton Pass WY", "Marquette MI", "Buffalo NY", "Snoqualmie WA"]
d, _ = get({"latitude": ",".join(str(PTS[n][0]) for n in names), "longitude": ",".join(str(PTS[n][1]) for n in names),
            "hourly": "precipitation,rain,showers,snowfall,temperature_2m", "timezone": "UTC", "forecast_days": 4})
bad = 0; n = 0
for nm, loc in zip(names, d):
    h = loc["hourly"]
    for i, t in enumerate(h["time"]):
        p, r, s, sn = (h[k][i] for k in ("precipitation", "rain", "showers", "snowfall"))
        if p and p >= 0.3:
            n += 1; res = p - r - s - sn * 10 / 7
            if abs(res) > 0.11:
                bad += 1
                if bad <= 8: print(nm, t, f"precip={p} rain={r} showers={s} snow_cm={sn} T={h['temperature_2m'][i]} resid_mm={res:.2f}")
print("wet hours (>=0.3mm):", n, "off by >0.11 mm:", bad)
