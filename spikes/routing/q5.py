"""Q5: Geoapify Address Autocomplete -- shape, US filtering, latency."""
import json, subprocess, time, urllib.parse
import tt
GK = tt.key("GEOAPIFY_API_KEY")
def ac(text, **kw):
    q = {"text": text, "apiKey": GK, "format": "json", "limit": 5}; q.update(kw)
    url = "https://api.geoapify.com/v1/geocode/autocomplete?" + urllib.parse.urlencode(q)
    return tt.get(url)
cases = [("Spring", {"filter": "countrycode:us", "type": "city"}),
         ("Spring", {}),                       # no filter: shows why filtering matters
         ("1600 Pennsylvania Ave, Washington", {"filter": "countrycode:us"}),
         ("Dalla", {"filter": "countrycode:us", "type": "city", "bias": "countrycode:us"})]
for text, kw in cases:
    j, code, dt, err = ac(text, **kw)
    res = (j or {}).get("results", [])
    print(f"{text!r} {kw} -> http {code}, {dt:.2f}s, {len(res)} results, err={err}")
    for r in res[:3]:
        print("   ", {k: r.get(k) for k in ("formatted", "country_code", "state_code", "city", "result_type", "lat", "lon")})
    if text == "Spring" and kw: print("  keys of one result:", sorted(res[0].keys())); print("  top-level keys:", sorted(j.keys()))
