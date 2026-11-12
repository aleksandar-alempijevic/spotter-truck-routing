"""TomTom Routing spike helpers (stdlib only). Reads keys from ../../.env; never prints them."""
import json, math, os, time, urllib.request, urllib.error, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.normpath(os.path.join(HERE, "..", "..", ".env"))
def key(name):
    for line in open(ENV):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip()
TT = key("TOMTOM_API_KEY")
CALLS = {"tomtom": 0}
BASE = "https://api.tomtom.com/routing/1/calculateRoute/"

def get(url, timeout=60):
    """GET via curl (urllib hit IncompleteRead on 300KB-3MB bodies). URL goes via stdin so the key is not in argv."""
    import subprocess
    t = time.time()
    p = subprocess.run(["curl", "-s", "--compressed", "-m", str(timeout), "-K", "-", "-w", "\n%{http_code}"],
                       input=f'url = "{url}"\n', capture_output=True, text=True)
    dt = time.time() - t
    out = p.stdout
    body, _, code = out.rpartition("\n")
    code = int(code) if code.isdigit() else 0
    if code == 0:
        return None, 0, dt, f"curl exit {p.returncode}"
    try:
        return json.loads(body), code, dt, None
    except Exception:
        return None, code, dt, body[:200].replace(TT or "?", "***")

def route(points, alts=2, weight=36000, depart="2026-11-17T08:00:00-06:00", extra=None, timeout=60):
    """points: list of (lat,lon): origin, [vias], dest."""
    loc = ":".join(f"{a:.5f},{b:.5f}" for a, b in points)
    q = {"key": TT, "travelMode": "truck", "maxAlternatives": alts, "departAt": depart,
         "routeType": "fastest", "traffic": "true"}
    if weight:
        q["vehicleWeight"] = weight
    q.update(extra or {})
    CALLS["tomtom"] += 1
    j, code, dt, err = get(BASE + loc + "/json?" + urllib.parse.urlencode(q), timeout)
    return j, code, dt, err

def pts(rt):
    return [(p["latitude"], p["longitude"]) for l in rt["legs"] for p in l["points"]]

def hav(a, b):
    R = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1]); dp = p2 - p1
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(h))

def cells(p, size=0.05):
    return {(round(x/size), round(y/size)) for x, y in p}

def overlap(b, a, size=0.05):
    """share of route b's length lying within ~1 cell (0.05 deg ~ 5 km) of route a."""
    ca = set()
    for x, y in a:
        cx, cy = round(x/size), round(y/size)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                ca.add((cx+dx, cy+dy))
    tot = sh = 0.0
    for i in range(1, len(b)):
        d = hav(b[i-1], b[i]); tot += d
        if (round(b[i][0]/size), round(b[i][1]/size)) in ca:
            sh += d
    return sh / tot if tot else 0
