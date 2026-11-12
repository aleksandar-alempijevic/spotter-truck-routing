"""Shared helper + snow/rain test points."""
import json, time, urllib.request, urllib.parse
def get(params, base="https://api.open-meteo.com/v1/forecast"):
    q = urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(base + "?" + q, headers={"User-Agent": "spotter-spike"}), timeout=60) as r:
        return json.loads(r.read()), dict(r.headers)
PTS = {"Berthoud Pass CO": (39.80, -105.78), "Vail Pass CO": (39.53, -106.22), "Teton Pass WY": (43.50, -110.95),
       "Donner Pass CA": (39.32, -120.33), "Snoqualmie WA": (47.42, -121.41), "Marquette MI": (46.55, -87.40),
       "Duluth MN": (46.79, -92.10), "Anchorage AK": (61.22, -149.90), "Fairbanks AK": (64.84, -147.72),
       "Buffalo NY": (42.89, -78.88), "Cheyenne WY": (41.14, -104.82), "Bozeman MT": (45.68, -111.04),
       "Marias Pass MT": (48.32, -113.35), "Rapid City SD": (44.08, -103.23), "Fargo ND": (46.88, -96.79)}
