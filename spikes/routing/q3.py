"""Q3: what the response offers for ETA at mile marks, and a verified interpolation sketch."""
import bisect, json, tt
from cities import CITIES as C

def eta_at_miles(route, step_mi):
    """Minimal-fields version: route needs legs[].points and guidance.instructions[{pointIndex, routeOffsetInMeters, travelTimeInSeconds}].
    Returns [(mile, lat, lon, seconds_from_departure)] every step_mi, plus the destination."""
    P = tt.pts(route)
    cum = [0.0]
    for i in range(1, len(P)): cum.append(cum[-1] + tt.hav(P[i-1], P[i]))
    ins = route["guidance"]["instructions"]
    # knots: (cumulative metres along OUR polyline at the instruction's pointIndex, travel seconds). Using geometry
    # distance for x keeps knots and query points on one scale; routeOffsetInMeters is TomTom's own and drifts slightly.
    kx = [cum[i["pointIndex"]] for i in ins]; kt = [i["travelTimeInSeconds"] for i in ins]
    # guard: strictly increasing x
    out, m = [], 0.0
    total = cum[-1]
    marks = [k*step_mi*1609.344 for k in range(int(total // (step_mi*1609.344)) + 1)] + [total]
    j = 0
    for x in marks:
        j = bisect.bisect_right(kx, x) - 1; j = max(0, min(j, len(kx)-2))
        span = kx[j+1]-kx[j]
        s = kt[j] + (kt[j+1]-kt[j]) * ((x-kx[j])/span if span else 0)
        # position: nearest polyline point at cumulative distance x
        pi = min(bisect.bisect_left(cum, x), len(P)-1)
        out.append((round(x/1609.344,1), P[pi][0], P[pi][1], round(s)))
    return out

if __name__ == "__main__":
    res = {}
    for name, pair in [("Chicago-Indianapolis", ("Chicago","Indianapolis")), ("Dallas-San Francisco", ("Dallas","San Francisco"))]:
        for itype in ("coded", "text"):
            j, code, dt, err = tt.route([C[pair[0]], C[pair[1]]], alts=0,
                extra={"instructionsType": itype, "sectionType": "travelMode"})
            if itype == "text" and name.startswith("Dallas"): pass
            r = j["routes"][0]; ins = r["guidance"]["instructions"]
            raw = len(json.dumps(j))
            print(f"{name} {itype}: {dt:.1f}s, json {raw/1e3:.0f} kB, points {len(tt.pts(r))}, instructions {len(ins)}, instr keys {sorted(ins[1].keys())}")
            if itype == "coded":
                P = tt.pts(r); cum = [0.0]
                for i in range(1, len(P)): cum.append(cum[-1]+tt.hav(P[i-1],P[i]))
                # offset vs our cumulative polyline distance at the instruction's pointIndex
                diffs = [abs(cum[i["pointIndex"]] - i["routeOffsetInMeters"]) for i in ins]
                print("  |polyline cum dist - routeOffsetInMeters| at instructions: max %.0f m, mean %.0f m; summary len %d m vs polyline %.0f m; last instr time %d vs summary %d" % (
                    max(diffs), sum(diffs)/len(diffs), r["summary"]["lengthInMeters"], cum[-1], ins[-1]["travelTimeInSeconds"], r["summary"]["travelTimeInSeconds"]))
                print("  sections:", [(s["sectionType"], s.get("travelMode"), sorted(s.keys())) for s in r.get("sections", [])][:3])
                # hold-out test: drop every 2nd instruction, interpolate it, compare to the true instruction time
                kx = [cum[i["pointIndex"]] for i in ins]; kt = [i["travelTimeInSeconds"] for i in ins]
                errs = []
                for q in range(1, len(ins)-1, 2):
                    a, b = q-1, q+1
                    est = kt[a] + (kt[b]-kt[a])*((kx[q]-kx[a])/(kx[b]-kx[a]) if kx[b] != kx[a] else 0)
                    errs.append(abs(est-kt[q]))
                errs.sort()
                print("  hold-out interpolation error (s) over %d knots: median %.0f, p95 %.0f, max %.0f" % (len(errs), errs[len(errs)//2], errs[int(len(errs)*.95)], errs[-1]))
                # constant-average-speed baseline (no instruction knots)
                tot = cum[-1]; T = r["summary"]["travelTimeInSeconds"]
                base = sorted(abs(T*kx[q]/tot - kt[q]) for q in range(1, len(ins)-1))
                print("  constant-speed baseline error (s): median %.0f, p95 %.0f, max %.0f" % (base[len(base)//2], base[int(len(base)*.95)], base[-1]))
                for step in (10, 25, 50):
                    e = eta_at_miles(r, step)
                    print(f"  step {step} mi -> {len(e)} checkpoints; first3 {e[:3]}; last {e[-1]}")
                res[name] = {"points": len(P), "instructions": len(ins), "holdout_median_s": errs[len(errs)//2], "holdout_p95_s": errs[int(len(errs)*.95)], "const_speed_p95_s": base[int(len(base)*.95)]}
            else:
                print("  text sample:", ins[2]["message"], "| coded sample:", {k: v for k, v in ins[2].items() if k in ("instructionType","maneuver","street","roadNumbers")})
    json.dump(res, open("results_q3.json","w"), indent=1)
    print("calls", tt.CALLS)
