"""Q1: how many routes come back (truck, 36,000 kg, departAt future, maxAlternatives=2), distinctness, latency."""
import json, tt
from cities import CITIES as C
PAIRS = [("Los Angeles","New York"),("Seattle","Miami"),("Chicago","Los Angeles"),("Dallas","San Francisco"),
         ("Denver","Atlanta"),("Chicago","Indianapolis"),("Dallas","Houston")]
out = []
for a, b in PAIRS:
    j, code, dt, err = tt.route([C[a], C[b]], alts=2)
    rec = {"pair": f"{a}-{b}", "http": code, "sec": round(dt,1), "err": err}
    if j and "routes" in j:
        rs = j["routes"]; P = [tt.pts(r) for r in rs]
        rec["n"] = len(rs)
        rec["routes"] = [{"mi": round(r["summary"]["lengthInMeters"]/1609.344), "h": round(r["summary"]["travelTimeInSeconds"]/3600,1),
                          "pts": len(p), "dev_km": round(r["summary"].get("deviationDistance",0)/1000)} for r, p in zip(rs, P)]
        # share of route i's length within ~5 km of route 0 (and of any earlier route)
        rec["overlap_vs_main"] = [round(tt.overlap(P[i], P[0]),2) for i in range(1, len(P))]
        rec["overlap_alt2_vs_alt1"] = round(tt.overlap(P[2], P[1]),2) if len(P) > 2 else None
    else:
        rec["body"] = (json.dumps(j)[:300] if j else None)
    print(json.dumps(rec)); out.append(rec)
json.dump(out, open("results_q1.json","w"), indent=1)
print("tomtom calls", tt.CALLS)
