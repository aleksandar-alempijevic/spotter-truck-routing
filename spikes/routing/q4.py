"""Q4 + Q2b: does vehicleWeight change routes; maxAlternatives with a waypoint; parameter-combo errors; limits."""
import json, tt
from cities import CITIES as C

def summ(j):
    if not (j and j.get("routes")): return None
    return [(round(r["summary"]["lengthInMeters"]/1609.344), round(r["summary"]["travelTimeInSeconds"]/3600,2)) for r in j["routes"]]
def ov(j, k):
    P = [tt.pts(r) for r in j["routes"]]; return round(tt.overlap(P[0], k[0]),3) if len(P) else None

rec = []
def log(name, j, code, dt, err, extra=""):
    e = None
    if j and "error" in j: e = j["error"]
    elif j and "detailedError" in j: e = j["detailedError"]
    elif j and "formatVersion" not in j and "routes" not in j: e = j
    row = {"case": name, "http": code, "sec": round(dt,1), "routes": summ(j), "err": (json.dumps(e)[:220] if e else err), "note": extra}
    print(json.dumps(row)); rec.append(row)

# --- weight vs none (identical geometry?) on 3 pairs
for a, b in [("Los Angeles","New York"), ("Denver","Atlanta"), ("Chicago","Indianapolis")]:
    j0, c0, d0, e0 = tt.route([C[a], C[b]], alts=2, weight=0)
    j1, c1, d1, e1 = tt.route([C[a], C[b]], alts=2, weight=36000)
    P0 = [tt.pts(r) for r in j0["routes"]]; P1 = [tt.pts(r) for r in j1["routes"]]
    same = [P0[i] == P1[i] for i in range(min(len(P0), len(P1)))]
    log(f"{a}-{b} no weight", j0, c0, d0, e0)
    log(f"{a}-{b} 36000kg", j1, c1, d1, e1, f"identical geometry per route: {same}")
# --- full truck profile (US 53ft tractor-trailer, metres) on short pair
j, c, d, e = tt.route([C["Chicago"], C["Indianapolis"]], alts=2, extra={"vehicleCommercial":"true","vehicleLength":16.2,"vehicleWidth":2.6,"vehicleHeight":4.1,"vehicleNumberOfAxles":5,"vehicleMaxSpeed":105})
log("Chicago-Indianapolis full truck profile", j, c, d, e)
# --- very heavy / silly weight values
j, c, d, e = tt.route([C["Chicago"], C["Indianapolis"]], alts=2, weight=80000)
log("Chicago-Indianapolis 80000 (lb entered as kg by mistake)", j, c, d, e)

# --- alternatives with waypoint
j, c, d, e = tt.route([C["Los Angeles"], C["Albuquerque"], C["New York"]], alts=2)
log("LA via Albuquerque NYC maxAlternatives=2", j, c, d, e,
    "n=%s legs/route=%s" % (len(j["routes"]) if j and "routes" in j else None, [len(r["legs"]) for r in j["routes"]] if j and "routes" in j else None))
if j and "routes" in j and len(j["routes"]) > 1:
    P = [tt.pts(r) for r in j["routes"]]
    print("   overlaps of alt vs main (waypoint case):", [round(tt.overlap(P[i], P[0]),2) for i in range(1, len(P))])
j, c, d, e = tt.route([C["Chicago"], C["Louisville"], C["Indianapolis"]], alts=2)
log("Chicago via Louisville Indianapolis maxAlternatives=2", j, c, d, e)

# --- error / limit probes (short pair where possible)
S = [C["Chicago"], C["Indianapolis"]]
for name, kw in [("maxAlternatives=6", dict(alts=6)),
                 ("departAt in the past", dict(depart="2026-11-01T08:00:00-06:00")),
                 ("departAt +30 days", dict(depart="2026-12-11T08:00:00-06:00")),
                 ("departAt +5 days, alts=5", dict(depart="2026-11-16T08:00:00-06:00", alts=5)),
                 ("computeBestOrder=true + alts=2", dict(extra={"computeBestOrder":"true"})),
                 ("arriveAt + departAt", dict(extra={"arriveAt":"2026-11-17T20:00:00-06:00"})),
                 ("vehicleWeight=36000 and routeType=shortest", dict(extra={"routeType":"shortest"})),
                 ]:
    j, c, d, e = tt.route(S, **kw); log(name, j, c, d, e)
# --- long-trip extremes
j, c, d, e = tt.route([C["Seattle"], C["Miami"]], alts=5, timeout=90); log("Seattle-Miami maxAlternatives=5", j, c, d, e)
j, c, d, e = tt.route([C["Los Angeles"], C["Albuquerque"], C["New York"]], alts=0, extra={"routeType":"shortest"}, timeout=90); log("LA-NYC via ABQ routeType=shortest", j, c, d, e)
json.dump(rec, open("results_q4.json","w"), indent=1)
print("calls", tt.CALLS)
