# Weather spike: Open-Meteo free API

Run 2026-11-11 against `https://api.open-meteo.com/v1/forecast`, no key. About 3,300 location-calls in total.
Scripts: `multi.py` (Q1 batch), `urllimit.py` (Q1 GET limit), `snow.py`, `resid.py` (Q3), `semantics.py`, `q4.py` (Q2/Q4), `grid.py` (Q5), `fetch.py` (recommended request + ETA picker). `common.py` is a helper. Python 3.13 stdlib only. Raw responses were not kept. "Observed" = seen in a live call; "docs" = from open-meteo.com/en/docs or /en/pricing; "inferred" = my reasoning.

## Verdict
Open-Meteo holds as primary. Units, horizon and variables are exactly what the app needs. The real constraint is quota: **each location in a multi-location call is billed as one call**, so the 600/min cap is 600 locations/min.

## Q1. Multi-location
Random CONUS points, 4 variables x 96 h, UTC.

| Points | Method | Result | Time | Payload | Cost header |
|---|---|---|---|---|---|
| 100 | GET | 200 | 1.9 s | 424 KB | 100 |
| 100 | POST | 200 | 4.4 s | 423 KB | 100 |
| 300 | GET (URL 5.4 KB) | 200 | 13.0 s | 1.27 MB | 300 |
| 300 | POST | 200 | 11.1 s | 1.27 MB | 300 |
| 600 | GET (URL 10.5 KB) | **414** | n/a | n/a | n/a |
| 600 | POST | 200 | 2.1 s | 2.54 MB | 600 |
| 1000 | GET (URL 17 KB) | **414** | n/a | n/a | n/a |
| 1000 | POST | 200 | 61 s | 4.24 MB | 1000 |

- Multi-location works; the pricing page's "future feature" wording is stale. Payload is about 4.2 KB per location, uncompressed (no `Content-Encoding` header seen).
- **GET URL limit is about 8,192 bytes** (bisected: 8,195 ok, 8,235 -> nginx 414). At 2-decimal coordinates that is roughly 440 points. **Use POST** (form-encoded body): 1,000 points worked.
- Timing is erratic, not linear in size (600 pts took 2 s, 300 took 13 s, 1000 took 61 s). Observed once each, so treat as noise; plan for up to a minute on 1,000 and chunk at about 100-200 per request with a concurrency cap.
- Quota accounting (observed): response header `X-RateLimit-Cost` equals the number of locations (1 location -> 1.0, 3 -> 3.0, 600 -> 600.0), with `X-RateLimit-Limit: 600`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Window: 60`. Docs: >10 variables or >2 weeks for one location also count as multiple calls; we use 4 variables and 4 days.
- A 1,000-point POST was accepted although the minute limit is 600 (remaining went to 0). After that, the next call returned **429** `"Minutely API request limit exceeded. Please try again in one minute."` with `Retry-After: 12`. Whether oversize calls are always accepted is not established (one observation).
- Limits (docs): 600/min, 5,000/hour, 10,000/day. At 1 location = 1 call, the daily cap is about 10,000 locations. An uncached 3-route cross-country trip at 25-mile spacing is roughly 3 x 120 = 360 locations, so cache by grid cell and rely on dedupe.
- Free tier is non-commercial, CC BY 4.0 attribution required (docs).

## Q2. Exact request
POST to `https://api.open-meteo.com/v1/forecast`, body (form-encoded):

```
latitude=39.74,39.32,...  longitude=-104.99,-120.33,...
hourly=wind_speed_10m,wind_gusts_10m,precipitation,snowfall
wind_speed_unit=mph  precipitation_unit=inch  timezone=UTC
forecast_hours=96  models=best_match
```

- Observed `hourly_units`: `wind_speed_10m: "mp/h"`, `wind_gusts_10m: "mp/h"`, `precipitation: "inch"`, `snowfall: "inch"`. Note the unit string is `mp/h`, not `mph`. `precipitation_unit=inch` converts snowfall to inches of snow depth too.
- Multi-location returns a JSON list in request order; a single location returns a bare object (normalise it). Returned lat/lon are snapped to the model grid (e.g. 39.74,-104.99 -> 39.7469,-104.9871), and `elevation` is returned.
- Horizon: `forecast_hours=96` returned 96 hourly stamps starting at the current UTC hour, with **0 nulls** for all four variables. `forecast_days=4` instead starts at 00:00 UTC today, so it gives only about 77 h ahead; prefer `forecast_hours`. Docs: up to 16 days.
- `best_match` at Denver: all 96 hours matched `models=gfs_seamless` exactly (96/96). `ncep_hrrr_conus` matched for the first 42 h then returned nulls; so best_match = HRRR for about 42 h, then GFS (observed). Other models differed. Docs say best_match layers regional models over a global backbone; the CONUS choice at other points was not checked (inferred it is the same). Research notes say HRRR is discontinued at the end of Nov 2026 (not re-verified here), so expect the near-term source to change; pin nothing to `ncep_hrrr_conus`.
- Hours are hourly through 96 h (observed, no gaps).

## Q3. Snow and rain
- Docs: `snowfall` is the preceding-hour sum, and "for the water equivalent in millimeter, divide by 7" (7 cm of snow = 10 mm of water).
- Observed (15 mountain/northern points, 57 snowy hours): with default units, `snowfall`(cm) / `precipitation`(mm) on pure-snow hours (rain = 0, precipitation >= 0.2 mm) has median 0.70 (21 hours; min 0.35, max 0.71; low values are 0.1 mm rounding). In inches the ratio is 7.0:1: `snowfall` (in) = 7 x water-equivalent (in). Example: Donner Pass 2026-11-14T02:00, snowfall 2.150 in, precipitation 0.307 in; 2.150 / 7 = 0.307.
- `snowfall` is a depth in inches of snow; `precipitation` is total liquid water (rain + showers + snow water equivalent). Identity check on 44 wet hours (>= 0.3 mm): `precipitation - rain - showers - snowfall/7` within 0.11 mm on 41; 3 Marquette hours were 0.2 mm short. In inches, Anchorage (different model) was off by up to 0.025 in, so do not use the `rain` or `showers` fields; derive from the two main fields.
- **Formula:** `snow_in_hr = snowfall`; `rain_in_hr = max(0, precipitation - snowfall / 7)`. Rain (liquid) bands compare against `rain_in_hr`, snow bands against `snowfall` depth, as decided in spec-analysis item 6.
- Caveat: the 7:1 ratio is fixed by Open-Meteo, not a real forecast ratio (real ratios vary about 5:1 to 20:1). That is a model assumption; thresholds work on its snow depth.

## Q4. Time semantics
- Docs: `precipitation`, `snowfall`: sum over the preceding hour; `wind_gusts_10m`: maximum over the preceding hour; `wind_speed_10m`: instantaneous value at the stamped hour.
- Observed support is weak. Wind: hourly value equalled the 15-minute value stamped at the same time in 408 of 432 hours (consistent with instantaneous). For precipitation, hourly vs the sum of four `minutely_15` values: ending at T matched 2/11 wet HRRR hours, starting at T 0/11 (an earlier run: 3/3 vs 0/3). Preceding is favoured but inconclusive because 15-minute values are interpolated. Gust reconciliation (26/48) was inconclusive. These semantics rest on docs.
- **ETA rule** (all UTC; `fetch.pick`):
  1. Wind speed (instantaneous): linearly interpolate between the stamps either side of the ETA (14:20 -> 14:00 x 2/3 + 15:00 x 1/3) (inferred).
  2. Gusts, precipitation, snowfall (preceding-hour totals/maxima): use the first stamp at or after the ETA (14:20 -> the 15:00 value, which covers 14:00-15:00). An ETA exactly on the hour uses that hour's stamp.
  3. ETA before the first stamp or after the last (about 96 h): no forecast.
- Parse `time` as UTC (naive ISO strings, `timezone=UTC`).

## Q5. Grid rounding
40 base points (30 random CONUS + 10 mountain/northern), a point shifted north by 0.05/0.1/0.25 deg (3.5/6.9/17 mi), first 48 h, 1,920 hour-pairs each. Elevation difference of the snapped cell: mean 68/118/183 m, max 502/737/840 m.

| Variable | Offset | Mean abs diff | p95 | Max | Hours changing risk band |
|---|---|---|---|---|---|
| wind (mph) | 0.05 | 1.5 | 5.6 | 11.3 | 0.16% |
| wind | 0.10 | 1.8 | 6.0 | 15.8 | 2.1% |
| wind | 0.25 | 2.6 | 8.1 | 28.9 | 2.1% |
| gusts (mph) | 0.05 / 0.10 / 0.25 | 1.7 / 2.2 / 3.2 | 6.8 / 8.1 / 10.1 | 20.8 / 23.7 / 33.3 | 2.6% / 4.4% / 5.8% |
| precipitation (in) | 0.05 / 0.10 / 0.25 | about 0.000 / 0.001 / 0.001 | 0 | 0.19 / 0.16 / 0.26 | 0.16% / 0.10% / 0.21% |
| snowfall (in) | all | about 0.001 | 0 | 0.19 / 0.55 / 0.50 | 0% |

Bands used: wind 25/35/45/55 mph, rain 0.10/0.25/0.50/1.00 in, snow 1/2/3 in (from spec-analysis item 1; the snow lower edges were not used). Precipitation is nearly identical at any of the spacings (97-99% identical hours); wind is the sensitive variable and is dominated by mountain points. **Recommendation: round to 0.1 deg (about 7 mi, within the 10-mile minimum checkpoint spacing) for the cache key; 0.05 deg if quota allows.** Key also on the forecast run hour (inferred: forecasts refresh hourly for HRRR, 6-hourly for GFS; not measured).

## Unit mapping

| Spec | Field | Unit as returned | Mapping |
|---|---|---|---|
| Wind (mph) | `wind_speed_10m` | `mp/h` | direct, interpolate at ETA |
| Gusts (shown beside wind) | `wind_gusts_10m` | `mp/h` | direct, hour at/after ETA |
| Rain (in/hr) | `precipitation`, `snowfall` | `inch` | `max(0, precipitation - snowfall/7)` |
| Snow (in/hr) | `snowfall` | `inch` | direct (depth) |
| Time | `time` | ISO 8601, UTC | parse as UTC |

## Risks
1. Quota: 1 location = 1 call; 600/min, 10,000/day per IP. Shared hosts (Render free) share the IP's budget. Heatmap grid cells and 3 routes multiply it; cache hard and throttle (429 gives `Retry-After`).
2. Large-call latency is unpredictable (61 s once for 1,000); chunk and cap concurrency.
3. Non-commercial licence plus attribution; a hiring take-home is a grey area.
4. Near-term model changes (HRRR retirement, per research.md) alter best_match; wind near thresholds varies between models.
5. Time semantics rest on docs; the 15-minute cross-check was inconclusive.
6. Fixed 7:1 snow ratio, not a physical forecast.
7. Fallback (NWS) not tested here.
