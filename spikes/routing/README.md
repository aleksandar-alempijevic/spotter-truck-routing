# Routing spike: TomTom truck routing and Geoapify autocomplete

Run on 2026-11-11 with `departAt=2026-11-17T08:00:00-06:00`, `travelMode=truck`, `vehicleWeight=36000` (kg) unless noted.
About 45 TomTom calls and 4 Geoapify calls. Keys are read from `../../.env` and never printed.

Files: `tt.py` (helpers: route call through curl, polyline overlap measure), `cities.py` (US hubs), `q1.py` ... `q5.py` (one per question), `results_q*.json` (compact results, no raw responses).

Overlap measure used throughout: share of route B's length (haversine along its polyline) lying within about 8 km (a 3x3 neighbourhood of 0.05 degree cells) of route A's points. 0 means fully separate, 1 means the same road. It is a rough measure, not a map-matched one.

## 1. How many routes, how distinct, how fast (observed)

| Pair | Routes | Miles | Hours | Overlap of alt 1 / alt 2 with main | Latency |
|---|---|---|---|---|---|
| Los Angeles to New York | **2** | 2813, 3040 | 40.1, 43.6 | 0.02 | 27 s (later runs 7-14 s) |
| Seattle to Miami | 3 | 3339, 3558, 3555 | 47.9, 50.8, 51.1 | 0.07 / 0.37 | 30 s (rerun 8.7 s) |
| Chicago to Los Angeles | 3 | 2018, 2239, 2527 | 28.7, 32.5, 37.2 | 0.07 / 0.02 | 10 s |
| Dallas to San Francisco | 3 | 1822, 1749, 2139 | 27.4, 27.7, 30.1 | 0.04 / 0.01 | 11 s |
| Denver to Atlanta | 3 | 1405, 1544, 1573 | 19.9, 22.5, 23.4 | 0.01 / 0.16 | 20 s |
| Chicago to Indianapolis (short) | 3 | 192, 218, 222 | 3.3, 4.1, 4.2 | 0.23 / 0.19 | 1.7 s |
| Dallas to Houston (short) | 3 | 238, 273, 309 | 3.4, 4.4, 5.4 | 0.09 / 0.08 | 2.6 s |

- 6 of 7 pairs return 3 routes with `maxAlternatives=2`; LA to NYC returns 2. The routes are mostly different corridors (overlap under 0.25), not small variations. Alternatives can cost 10-55% more time than the main route, so the third route is sometimes much slower (Dallas to Houston third route: 5.4 h against 3.4 h).
- Order is not strictly by time or length: in Dallas to San Francisco alternative 1 is shorter in miles but slower than the main route. Rank on the numbers, not on array position.
- Latency on long trips is 8-30 s and varies a lot between identical calls (Seattle to Miami 30 s, then 8.7 s; probably a cold server-side cache, inferred). Short trips take 1-3 s. Response bodies are 0.5-3 MB per route set uncompressed JSON (curl `--compressed` gives about 465 kB for LA to NYC).
- Every response had `trafficDelayInSeconds: 0` with a future `departAt` (observed), so ETAs come from historical/typical speeds, not live traffic.
- Travel time is pure driving time. It contains no breaks or hours-of-service stops, so a 40-hour result is 40 hours of wheel time (observed from the numbers; the spec's ETA at each checkpoint therefore assumes no rests).

## 2. Via-city fill for a missing third route

Method (`q2.py`): take cities that lie 15-85% of the way along the origin-destination line, have a crow-flies detour ratio of at most 1.30, and are at least 120 km from the main route's polyline; take the lowest-detour one on each side of the line. One call per via-city with `maxAlternatives=0`.

| Pair | Base routes | Via-city | Via route miles / hours | Overlap with base routes | Verdict |
|---|---|---|---|---|---|
| Los Angeles to New York | 2 (2813 and 3040 mi) | Albuquerque | 2846 mi / 41.7 h | 0.05 and 0.09 | **usable**, +33 mi, +1.6 h over main |
| Los Angeles to New York | same | Kansas City | 2833 mi / 40.6 h | 0.37 and 0.03 | weaker, shares 37% with main |
| Phoenix to Boston (base already 3) | 3 | Louisville | 2750 mi | 0.87 with main | useless as third route |
| Phoenix to Boston | 3 | Kansas City | 2822 mi | 0.79 with main | useless |
| Houston to Minneapolis (base 3) | 3 | Little Rock | 1452 mi / 20.8 h | 0.37, 0.26, 0.01 | distinct from the third route, partly shared with the first two |

- The only real "fewer than 3" case found was LA to NYC, and the via fill worked there with the city on the lowest-overlap side. The Phoenix to Boston check shows the method can return a near-copy when the base routes already cover the corridors, so a distinctness filter (for example overlap with every existing route below about 0.5) is needed; picking by smallest detour is not enough.
- **`maxAlternatives` still works with a waypoint** (observed): LA via Albuquerque to NYC with `maxAlternatives=2` returned 3 routes, each with 2 legs (so all pass through the via-city), overlaps 0.09 and 0.18 with the first. Chicago via Louisville to Indianapolis also returned 3. So the via call can request alternatives too. `computeBestOrder=true` with alternatives is a 400.
- Cost of the fill: 1 extra call per via candidate, 7-11 s on long trips. Inferred recommendation: try the via-city whose lateral offset from the main route is largest within the detour limit; reject it if overlap with any existing route is above the threshold; try the other side once.
- Not tested: pairs where TomTom returns 1 route, and via-city selection from a larger or automated city list.

## 3. ETA at 10/25/50 mile marks (observed, `q3.py`)

Minimal request: `calculateRoute/{lat,lon}:{lat,lon}/json` with `travelMode=truck&vehicleWeight=<kg>&departAt=<iso>&maxAlternatives=2&instructionsType=coded&sectionType=travelMode` (the key goes in `key=`). Without `instructionsType` the response has no `guidance` block, so no per-instruction times.

Fields used per route:
- `summary.lengthInMeters`, `summary.travelTimeInSeconds`, `summary.departureTime`, `summary.arrivalTime`.
- `legs[].points[]` as `{latitude, longitude}`: dense geometry (about 120-150 m spacing; 38,644 points for 2,813 miles).
- `guidance.instructions[]`: each has `pointIndex` (index into the concatenated `legs[].points`), `routeOffsetInMeters` and `travelTimeInSeconds` (cumulative from departure), plus `point`, `street`, `stateCode`. Spacing is sparse on interstates (68 instructions for a 1,820-mile trip, about 27 miles apart). `coded` and `text` give the same instruction count; `text` only adds message strings, but one text call took 11.6 s against 3.1 s for coded on the same trip (a single sample, perhaps noise).
- There is **no per-point travel time**. `sections` (`sectionType=travelMode`) only gives index ranges and truck/other mode; `sectionType=traffic` gave index ranges with delay data but no cumulative time. Whether instruction offsets and times stay cumulative across the legs of a via-city route was not checked; verify before relying on it (`points` are concatenated across `legs[]` in the helper).
- Consistency: the last instruction's `travelTimeInSeconds` equals `summary.travelTimeInSeconds` exactly on both routes tested. The haversine distance of the polyline at `pointIndex` differs from `routeOffsetInMeters` by up to 49 m on a 192-mile trip and up to 2.6 km on a 1,820-mile trip, since the sparse polyline cuts corners.

Interpolation sketch (implemented in `q3.py`, function `eta_at_miles`):
1. Build cumulative haversine distance along the concatenated points.
2. Knots are the instructions: x = cumulative distance at `pointIndex`, y = `travelTimeInSeconds`.
3. For a checkpoint at mile k, x = k * 1609.344, find the surrounding knots by bisection, and linearly interpolate time; the position is the polyline point at that cumulative distance. Add the time to `departAt` for the ETA.
4. Cleaner alternative (inferred, not run): use `routeOffsetInMeters` as x and scale the polyline distance by `summary.lengthInMeters / cumulative_end` to remove the cornering drift.

Accuracy (hold-out test: drop every second instruction, interpolate it back, compare to its true time): Chicago to Indianapolis median 7 s, p95 53 s over 17 knots; Dallas to San Francisco median 3 s, p95 16 s, max 107 s over 33 knots. A constant-average-speed estimate with no knots was off by a median of 418 s and 1,631 s respectively (p95 1,020 s and 4,661 s). So the knot interpolation is accurate to about a minute against TomTom's own times, and is far better than the constant-speed approach. Checkpoint counts: Dallas to San Francisco gives 184 / 74 / 38 checkpoints for 10 / 25 / 50 miles.

## 4. Does `vehicleWeight` change routes; limits and errors

- **Yes, it changed routes** (observed, same pair with `vehicleWeight` omitted and 36000): LA to NYC main 2800 mi / 39.95 h became 2813 mi / 40.12 h; Chicago to Indianapolis main 183 mi / 2.89 h became 192 mi / 3.33 h (+15% time); Denver to Atlanta main identical but alternatives changed (1624 mi became 1544 mi). Geometry was not identical for any route set. This contradicts the research note "load weight barely changes routing" for 36,000 kg. The effect is moderate, and the mechanism (road weight restrictions, or heavy-vehicle speed rules) was not isolated. The weight in the spec's risk rules is still separate.
- 80,000 passed by mistake (lb as kg) returned a normal result, no error; adding length/width/height/axles/`vehicleCommercial` also worked (Chicago to Indianapolis 3.52 h). The API does not validate plausibility, so convert pounds to kilograms in the backend.
- Errors seen (all 400 `BAD_INPUT`): `maxAlternatives=6` (range is 0 to 5), `computeBestOrder=true` with alternatives, `departAt` together with `arriveAt`.
- No error for: `departAt` in the past or 30 days ahead (just returned a route; the past date is accepted, inferred to be treated as typical traffic), `routeType=shortest` (LA to NYC via Albuquerque: 7.3 s).
- **Timeout**: Seattle to Miami with `maxAlternatives=5` returned HTTP 500 at 31 s: "exceeded the internal compute time limit". The same pair with `maxAlternatives=2` took 30 s on its first call (right at the limit) and 8.7 s on the rerun. Keep to `maxAlternatives=2` on trips over about 2,000 miles, set the client timeout to at least 45 s and retry once. `maxAlternatives=5` on a 200-mile trip returned 6 routes in 3 s.
- Fields are verbose: use `Accept-Encoding: gzip`. (Python `urllib` failed with `IncompleteRead` on 0.3-3 MB bodies, so the helper calls `curl`; `httpx` was not tried and may not have the issue.)

## 5. Geoapify Autocomplete (observed, `q5.py`)

`GET https://api.geoapify.com/v1/geocode/autocomplete?text=...&filter=countrycode:us&type=city&format=json&limit=5&apiKey=...`

- Response (`format=json`): `{query, results[]}`; each result has `formatted`, `lat`, `lon`, `city`, `state`, `state_code`, `country_code`, `result_type` (`city`, `building`, ...), `place_id`, `rank`, `timezone`, `bbox`.
- Filtering: `filter=countrycode:us` returned only US places ("Spring" gave Colorado Springs, Springfield IL and MO); without it the second hit was Springe, Germany and the third a Russian village. Use `filter=countrycode:us`; `bias` is not needed with it.
- Latency 0.6 s (city queries), 1.1-1.2 s (address, and one unfiltered query). 4 calls total.
- Address quality: "1600 Pennsylvania Ave, Washington" returned buildings in Maryland, Washington state and Ohio, not the DC address, so a partial query is ambiguous; a full query with state would be needed (not tested). City-level input is enough for this app.

## Recommendation

- **d5 holds**: TomTom truck mode returns usable, distinct routes on 2,000-3,000 mile trips, and Geoapify with the US filter works and is fast. One correction to the research note: weight does change routes (see 4), so pass `vehicleWeight`.
- **d4 holds, with changes**: TomTom alone returned 3 routes on 6 of 7 pairs, and the via-city fill produced a distinct third route on the one pair that fell short (LA to NYC via Albuquerque). The fill needs (1) a distinctness check against every existing route, (2) a fallback to the other side if the first via-city overlaps, and (3) a decision for the case where even that fails (show 2 routes, flagged). Do not promise "always 3" in the UI without this.
- Compute ETA from `guidance.instructions` knots plus polyline distance (section 3), not from average speed.

## Risks

1. Long-trip latency of up to 30 s sits at TomTom's compute limit; a 500 can occur. Mitigate with `maxAlternatives=2`, a generous timeout, one retry, and a cache by route key. (Render's free-tier request timeout was not checked.)
2. The sample is 7 pairs, mostly between big cities; coverage of rural pairs and of cases where TomTom returns 1 route was not tested.
3. Time is driving time only; the spec's ETAs will not include breaks unless the app adds them.
4. Via-city choice used a hand list of 45 cities; an automated selection is not built.
5. TomTom terms on caching and public demo use remain unread (per research.md); free-quota use so far is about 45 requests against a documented 20k/month (inferred from the research note's 20k/month figure; the daily cap was not checked).
6. Keys must stay server-side; the key sits in the query string of TomTom's API, so avoid logging full URLs.
