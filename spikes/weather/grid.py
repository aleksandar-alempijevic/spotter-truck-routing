"""Q5: forecast sensitivity to grid offset (0.05/0.1/0.25 deg north of base), first 48 h, risk-band flips."""
import random, statistics as st, bisect
from common import get, PTS
random.seed(7)
base = [(round(random.uniform(26, 48), 3), round(random.uniform(-122, -75), 3)) for _ in range(30)] + [PTS[n] for n in
        ["Donner Pass CA", "Teton Pass WY", "Berthoud Pass CO", "Marias Pass MT", "Snoqualmie WA", "Marquette MI", "Buffalo NY", "Cheyenne WY", "Bozeman MT", "Rapid City SD"]]
offs = [0, 0.05, 0.1, 0.25]
locs = [(round(a + o, 3), b) for (a, b) in base for o in offs]
def run(coords):
    return get({"latitude": ",".join(str(a) for a, _ in coords), "longitude": ",".join(str(b) for _, b in coords),
                "hourly": "wind_speed_10m,wind_gusts_10m,precipitation,snowfall", "wind_speed_unit": "mph", "precipitation_unit": "inch",
                "timezone": "UTC", "forecast_hours": 48})[0]
out = run(locs)
BANDS = {"wind_speed_10m": [25, 35, 45, 55], "wind_gusts_10m": [25, 35, 45, 55], "precipitation": [0.10, 0.25, 0.50, 1.00], "snowfall": [1.0, 2.0, 3.0]}
print("n base points", len(base), "elev diff (m) mean/max by offset:")
for oi, o in enumerate(offs[1:], 1):
    ed = [abs(out[4 * k + oi]["elevation"] - out[4 * k]["elevation"]) for k in range(len(base))]
    print(f"  {o}: {st.mean(ed):.0f} / {max(ed):.0f}")
for var, edges in BANDS.items():
    print(var)
    for oi, o in enumerate(offs[1:], 1):
        diffs = []; flips = n = 0
        for k in range(len(base)):
            a, b = out[4 * k]["hourly"][var], out[4 * k + oi]["hourly"][var]
            for x, y in zip(a, b):
                if x is None or y is None: continue
                diffs.append(abs(x - y)); n += 1
                flips += bisect.bisect_right(edges, x) != bisect.bisect_right(edges, y)
        diffs.sort()
        print(f"  {o:5}: mean|d|={st.mean(diffs):.3f} p95={diffs[int(.95*len(diffs))]:.3f} max={diffs[-1]:.3f} identical={sum(d==0 for d in diffs)/len(diffs):.0%} band_flips={flips}/{n} ({flips/n:.2%})")
