"""Q1: multi-location batch test (GET and POST). Raw responses are not saved."""
import json, random, time, urllib.request, urllib.parse
BASE = "https://api.open-meteo.com/v1/forecast"
VARS = "wind_speed_10m,wind_gusts_10m,precipitation,snowfall"
COMMON = {"hourly": VARS, "wind_speed_unit": "mph", "precipitation_unit": "inch",
          "timezone": "UTC", "forecast_days": "4"}
random.seed(1)
def pts(n):
    return [(round(random.uniform(26, 48), 2), round(random.uniform(-122, -75), 2)) for _ in range(n)]
def call(n, method):
    p = pts(n)
    params = dict(COMMON, latitude=",".join(str(a) for a, _ in p), longitude=",".join(str(b) for _, b in p))
    q = urllib.parse.urlencode(params)
    t = time.time()
    try:
        if method == "GET":
            req = urllib.request.Request(BASE + "?" + q, headers={"User-Agent": "spotter-spike"})
        else:
            req = urllib.request.Request(BASE, data=q.encode(), method="POST", headers={"User-Agent": "spotter-spike"})
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read(); h = dict(r.headers); code = r.status
    except urllib.error.HTTPError as e:
        body = e.read(); h = dict(e.headers); code = e.code
    dt = time.time() - t
    info = {"n": n, "method": method, "status": code, "secs": round(dt, 2), "url_len": len(q) + len(BASE) + 1,
            "bytes": len(body), "cost": h.get("X-RateLimit-Cost"), "remaining": h.get("X-RateLimit-Remaining"),
            "enc": h.get("Content-Encoding")}
    try:
        d = json.loads(body); info["locs"] = len(d) if isinstance(d, list) else 1
        if code != 200: info["err"] = str(d)[:300]
    except Exception: info["err"] = body[:200].decode("utf8","replace")
    return info
if __name__ == "__main__":
    for n in (100, 300, 600, 1000):
        for m in ("GET", "POST"):
            print(json.dumps(call(n, m)), flush=True); time.sleep(8)
