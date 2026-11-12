"""Q2: when <3 routes come back, pick via-cities off the main route and check the via-route is distinct."""
import json, math, sys, tt
from cities import CITIES as C

def side_and_lateral(o, d, c):
    """Equirectangular approx: returns (t along o->d in 0..1, signed lateral km, detour ratio)."""
    k = math.cos(math.radians((o[0]+d[0])/2))
    ox, oy, dx, dy, cx, cy = o[1]*k, o[0], d[1]*k, d[0], c[1]*k, c[0]
    vx, vy = dx-ox, dy-oy; L2 = vx*vx+vy*vy
    t = ((cx-ox)*vx+(cy-oy)*vy)/L2
    cross = (vx*(cy-oy)-vy*(cx-ox))/math.sqrt(L2)   # deg
    detour = (tt.hav(o, c)+tt.hav(c, d))/tt.hav(o, d)
    return t, cross*111.0, detour

def pick_vias(a, b, main_pts, n_per_side=1):
    o, d = C[a], C[b]; cands = {1: [], -1: []}
    for name, c in C.items():
        if name in (a, b): continue
        t, lat, det = side_and_lateral(o, d, c)
        if not (0.15 <= t <= 0.85) or det > 1.30: continue
        # distance from the actual main route (nearest polyline point, subsampled) -- city must be off-corridor
        off = min(tt.hav(c, p) for p in main_pts[::20]) / 1000
        if off < 120: continue
        cands[1 if lat > 0 else -1].append((det, off, name))
    return {s: sorted(v)[:n_per_side] for s, v in cands.items()}

def run(a, b, n_vias_per_side=1):
    j, code, dt, err = tt.route([C[a], C[b]], alts=2)
    P = [tt.pts(r) for r in j["routes"]]
    base = [round(r["summary"]["lengthInMeters"]/1609.344) for r in j["routes"]]
    print(f"\n== {a}-{b}: base returns {len(P)} routes, mi={base}, {dt:.0f}s")
    out = {"pair": f"{a}-{b}", "base_n": len(P), "base_mi": base, "vias": []}
    for s, lst in pick_vias(a, b, P[0], n_vias_per_side).items():
        for det, off, name in lst:
            j2, c2, dt2, e2 = tt.route([C[a], C[name], C[b]], alts=0)
            if not (j2 and j2.get("routes")):
                print("via", name, "failed", c2, e2, json.dumps(j2)[:200] if j2 else ""); continue
            r = j2["routes"][0]; p = tt.pts(r)
            ov = [round(tt.overlap(p, q), 2) for q in P]
            mi = round(r["summary"]["lengthInMeters"]/1609.344)
            rec = {"via": name, "side": s, "detour_ratio_crow": round(det,2), "via_off_main_km": round(off), "mi": mi,
                   "h": round(r["summary"]["travelTimeInSeconds"]/3600,1), "overlap_vs_base_routes": ov, "sec": round(dt2,1)}
            print(json.dumps(rec)); out["vias"].append(rec)
    return out, P

if __name__ == "__main__":
    res = []
    for a, b in [("Los Angeles","New York"), ("Phoenix","Boston"), ("Houston","Minneapolis")]:
        r, _ = run(a, b); res.append(r)
    json.dump(res, open("results_q2.json","w"), indent=1)
    print("calls", tt.CALLS)
