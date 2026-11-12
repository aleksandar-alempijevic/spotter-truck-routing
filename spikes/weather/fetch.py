"""Recommended Open-Meteo request + unit mapping + ETA picker (the contract the Django backend would implement)."""
import datetime as dt, json, math, urllib.parse, urllib.request
URL = "https://api.open-meteo.com/v1/forecast"
PARAMS = {"hourly": "wind_speed_10m,wind_gusts_10m,precipitation,snowfall", "wind_speed_unit": "mph",
          "precipitation_unit": "inch", "timezone": "UTC", "forecast_hours": 96, "models": "best_match"}
SNOW_TO_WATER = 7.0  # snowfall (in) / 7 = liquid-equivalent (in); verified in snow.py / resid.py

def fetch(points):
    """points: [(lat, lon)], <=1000 per POST. Returns list of per-location dicts (single dict if 1 point -> normalised to list)."""
    body = urllib.parse.urlencode(dict(PARAMS, latitude=",".join(f"{a:.2f}" for a, _ in points),
                                       longitude=",".join(f"{b:.2f}" for _, b in points))).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers={"User-Agent": "spotter-spike"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read()); cost = r.headers.get("X-RateLimit-Cost")
    return (d if isinstance(d, list) else [d]), cost

def pick(hourly, eta_utc):
    """Values for an ETA (aware UTC datetime). Wind: instantaneous at stamp -> linear interpolation between surrounding hours.
    Gust/precip/snow: totals/maxima of the PRECEDING hour -> the stamp at or after the ETA (ceil)."""
    times = [dt.datetime.fromisoformat(t).replace(tzinfo=dt.timezone.utc) for t in hourly["time"]]
    def idx_ceil(): return next((i for i, t in enumerate(times) if t >= eta_utc), None)
    c = idx_ceil()
    if c is None or eta_utc < times[0]: return None
    f = c if times[c] == eta_utc else c - 1
    w = hourly["wind_speed_10m"]
    if times[c] == eta_utc or f < 0: wind = w[c]
    else:
        frac = (eta_utc - times[f]).total_seconds() / 3600; wind = w[f] + (w[c] - w[f]) * frac
    snow = hourly["snowfall"][c]; prec = hourly["precipitation"][c]
    return {"wind_mph": wind, "gust_mph": hourly["wind_gusts_10m"][c], "snow_in_hr": snow,
            "rain_in_hr": max(0.0, prec - snow / SNOW_TO_WATER), "precip_in_hr": prec}

if __name__ == "__main__":
    locs, cost = fetch([(39.74, -104.99), (39.32, -120.33), (46.55, -87.40)])
    print("cost", cost, "units", locs[0]["hourly_units"], "hours", len(locs[0]["hourly"]["time"]))
    now = dt.datetime.now(dt.timezone.utc)
    for l in locs: print(l["latitude"], l["longitude"], pick(l["hourly"], (now + dt.timedelta(hours=30, minutes=20)).replace(tzinfo=dt.timezone.utc)))
