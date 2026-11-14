# Risk and ranking logic

How the app turns weather into a risk level, a route's checkpoints into a summary, and route summaries into a recommendation. The code is the plain-Python package [backend/risk_rules/](../backend/risk_rules/), tested in `backend/tests/test_risk_levels.py`, `test_route_summary.py`, `test_route_ranking.py` and `test_risk_rules_boundary.py`. The package imports only the standard library, so it can be read and tested without Django, and the API layer calls it, never the reverse.

Units throughout are the assessment's: sustained wind in mph, rain and snow in inches per hour, load in pounds, distances in miles. Converting a weather provider's fields into these units happens before this package is called.

## 1. Risk level at one checkpoint

`classify_weather(reading, load_lb)` takes a reading (sustained wind, rain rate, snow rate) and the load weight, and returns the level, the condition that decided it (none at Low, where nothing decided it) and whether a load rule raised it.

Levels, lowest to highest: Low, Moderate, High, Severe, No Travel.

| Condition | Low | Moderate | High | Severe | No Travel |
|---|---|---|---|---|---|
| Wind (mph) | < 25 | 25 to < 35 | 35 to < 45 | 45 to < 55 | >= 55 |
| Rain (in/hr) | < 0.10 | 0.10 to < 0.25 | 0.25 to < 0.50 | 0.50 to 1.00 | > 1.00 |
| Snow (in/hr) | < 0.5 | 0.5 to < 1.0 | 1.0 to < 2.0 | 2.0 to 3.0 | > 3.0 |

**Band edges.** The assessment's bands touch or overlap at their edges (0.25 in/hr rain is both Moderate and High). A value on an edge goes to the higher band, so 25 mph wind is Moderate and 0.25 in/hr rain is High. The top band keeps the assessment's wording: wind of exactly 55 mph is No Travel, but exactly 1.00 in/hr of rain and exactly 3.0 in/hr of snow are Severe, because No Travel is "more than" those values. Wind bands are written as whole numbers in the assessment; they are read as half-open ranges, so 34.9 mph is Moderate. Comparisons are exact: the classifier does not round.

**Load rules** apply to wind only, and only raise the level:

| Wind | Load | Level |
|---|---|---|
| >= 55 mph | any | No Travel |
| 45 to < 55 mph | more than 30,000 lb | No Travel (otherwise Severe) |
| 35 to < 45 mph | more than 40,000 lb | Severe (otherwise High) |

A load of exactly 30,000 or 40,000 lb does not trigger its rule. Rain and snow ignore the load.

**Combining conditions.** First the three conditions are levelled on the weather alone, with no load rule. The worst of those is the weather-alone level, and when more than one condition has it, wind is named before rain and rain before snow. At Low no condition is named. Then the load rules are applied to wind. If the load-adjusted wind level is above every weather-alone level, the checkpoint takes that level, the condition is wind and `load_raised` is true, which is what lets the UI explain a Severe at 38 mph. Otherwise the weather-alone level and condition stand and `load_raised` is false. So a heavy load at 40 mph with rain already Severe is Severe because of rain, not because of the load.

**Gusts** are not part of the reading. They are shown beside the level and never change it: the assessment says "wind", read here as sustained wind.

**Inputs must be real measurements.** Every field must be a finite number of at least 0; anything else (NaN, infinity, a negative) is rejected. Missing weather is never passed in as a number: the caller leaves the checkpoint's level absent.

## 2. Route summary

`summarize_route(total_miles, checkpoints)` takes a route's length and its checkpoints, each a mile mark and a level (or none), and returns the miles at each level, the miles with no forecast and the average risk. The summary is immutable and checks its own consistency when built: miles are finite and non-negative, and the average risk is present exactly when some miles have a forecast and equals the mile-weighted average of the level scores.

- **Each checkpoint stands for the road from its mark up to the next mark**; the last one stands for the road to the end of the route. A checkpoint at the destination stands for no miles.
- **Marks must start at mile 0, strictly ascend and not pass the route's end.** A route that violates this is rejected, not repaired, so no road goes unattributed.
- **Average risk** scores Low 0, Moderate 1, High 2, Severe 3, No Travel 4 and averages by miles, so a long segment counts more than a short one. No Travel's score only matters among routes that all have No Travel miles; those rank last regardless.
- **No forecast.** A checkpoint past the forecast range has no level. Its miles are counted separately, are left out of the level miles and the average, and are never treated as Low. A route with no forecasted miles at all has no average risk.

## 3. Ranking

`rank_routes(candidates, checkpoint_interval_miles)` takes one to three routes (id, travel time, summary; the length comes from the summary) and the checkpoint spacing the request used (10, 25 or 50 miles).

The routes are filtered in the assessment's order of preference. At each step the routes within a tolerance of the best value stay in; the rest drop out of the contest for first place:

| Step | Keeps routes with | Tolerance |
|---|---|---|
| 1. No Travel | fewest No Travel miles | none |
| 2. Severe | fewest Severe miles | none |
| 3. High | High miles no more than the best plus one checkpoint interval | one interval |
| 4. Average risk | routes whose average risk, lowered by their own tolerance, is no higher than the best average among the routes still in | one interval / the route's own forecast miles, at most one level |
| 5. Travel time | shortest travel time | none |
| 6. Miles | fewest total miles | none |
| 7. Route id | smallest id | none |

The first step that leaves a single route decides first place, and the ranking reports which step that was. Second and third place repeat the same steps over the routes not yet placed. A single route is first with no deciding step (`decided_by` is none) and no comparison, and is recommended unless it has No Travel miles, judged with `FLOAT_MARGIN`. The result is the same whatever order the routes arrive in.

**Why these tolerances.** The smallest difference the data can show is one checkpoint changing by one level, and a difference that size cannot be told apart from forecast noise. Within it, the next criterion decides, so travel time decides whenever the safety difference is that small, and never overrides a real Severe or High difference. Severe has no tolerance: one more Severe checkpoint always loses, however much faster the route is.

**No Travel.** The assessment's list leaves No Travel out. Any route with No Travel miles ranks below every route without them, and among routes that all have them the one with the fewest No Travel miles ranks first. A first-ranked route that has No Travel miles is not recommended: the result's `recommended_id` is empty and the UI should say no route is safe to recommend.

**The average-risk tolerance** belongs to each route: one checkpoint interval divided by that route's own forecast miles (miles whose checkpoint has a forecast), at most one level. That is how far one full-interval checkpoint moving by one level shifts the route's mile-weighted average, so it is in the same unit as the average and holds for routes whose length is not a multiple of the interval. The cap keeps a route forecast for less than one interval from getting a tolerance of more than one level. A route stays in the contest when its average risk, lowered by its own tolerance, is no higher than the lowest average among the routes still in. Put differently, a route is tied with the best if one of its checkpoints scoring one level lower would make it the safest. A route's tolerance depends only on that route, so another route's length or forecast coverage does not change it. A route with no average risk (no forecasted miles) counts as worse than any average, so it drops at step 4 whenever another route has one. If no route has an average, the step is skipped.

**Ties do not chain.** At each step a route is compared with the best route still in the contest, not with every other route. Adding a third route can therefore occasionally change which of the other two wins. Example: three routes of 500 miles at a 25-mile interval. Route a is all Low and takes 900 minutes, route b has one Moderate checkpoint and takes 600, route c has two Moderate checkpoints and takes 300. Each route's tolerance is 0.05, and the averages are 0, 0.05 and 0.10. Ranking only b and c: they are within tolerance, so the faster c wins on time. Ranking all three: the best average is a's 0, b is within tolerance of it and c is not, so c drops at average risk and b wins on time. This is accepted. Pairwise, the result still does not depend on the order the routes are given in.

**One High checkpoint against none.** A route with one High checkpoint and an otherwise identical all-Low route are one interval apart in High miles, so the route survives the High step. It then loses at average risk: High against Low is a two-level difference, and the tolerance absorbs one level. A tie at the High step is therefore not a tie overall. The route reaches the time step only if its average risk is also within tolerance, for example when the other route has comparable Moderate miles.

**Tolerance edges and rounding.** A gap of exactly one interval is a tie. Segment miles are differences of floating-point marks, so a gap that is one interval on paper can come out a hair either side. Two values closer than `FLOAT_MARGIN` (0.000001, in miles, risk points or seconds) count as equal, including at the average-risk edge. Real differences are many orders of magnitude larger than the margin.

**No-forecast miles** do not enter any step, so a route that is mostly past the forecast range is compared on the part that has a forecast, with a tolerance sized to that part. A route's own tolerance is therefore wide when little of it is forecast, so a route forecast for only a small part can tie with a fully forecast safer route. Example: three 500-mile routes at a 25-mile interval, a all Low (900 s), w Moderate for its first 25 miles and no forecast for the other 475 (300 s), r Moderate for 100 miles and then Low (600 s). w's average of 1.0 is the worst, but its tolerance is the full level, so it stays in with a and wins on time, while r (average 0.2, tolerance 0.05) drops at average risk against a. This needs a trip that runs past the forecast range, which is rare. The ranking returns each route's no-forecast miles so the UI can show them.

**Output.** For each route in rank order: its rank, its no-forecast miles, its average-risk tolerance (`average_risk_tolerance`, none if the route has no average risk; it is given for every route, including the first, so a winner that stayed in on its own wider tolerance can be explained) and, for every route except the first, the step at which it left the contest for first place, what it was measured against there (the best route still in the contest at that step, the dropped route's value, the best value and the dropped route's tolerance) and its differences from the first route (travel time in seconds, No Travel, Severe and High miles, and average risk; each is the route's value minus the first route's). The UI uses these for lines like "+38 min, avoids 50 Severe miles" and to show which values were ties: a route that survived a step was within tolerance on it. The first route's deciding step names the reason for the recommendation. The output explains first place only: the step at which second and third place dropped out of the contest for first place is not an order between them, and should not be read as one. The route a dropped route lost to at its step is not always the first route: in the example above, c drops at average risk against a, while b wins.

A cap on how much extra time a safer route may cost is not part of the assessment and is not applied.

## 4. What the callers must supply

- Weather in the units above, with no forecast represented as an absent level. The weather endpoint builds each reading from Open-Meteo's series at the checkpoint's ETA ([architecture.md](architecture.md)), and leaves a checkpoint the forecast does not reach without a level.
- Checkpoints with a mark at mile 0, ascending, inside the route. The routes endpoint produces them in this form, with a final checkpoint at the destination, and the weather endpoint rejects a body that breaks it before the rules see it.
- Unique route ids, one to three routes per ranking, and one checkpoint interval for the request.
- Travel time in seconds: driving time, or door-to-door time when the routes request turned rest breaks on ([section 5](#5-rest-breaks-when-they-are-on)).

## 5. Rest breaks (when they are on)

The routes request can add the federal hours-of-service stops to the ETAs ([assumptions.md](assumptions.md#when-rest-breaks-are-on) for the readings it rests on). The rule is the one function `plan_stops` in [backend/routing/rest_breaks.py](../backend/routing/rest_breaks.py), from a route's driving time to its list of stops; the clock times, the stop positions and the trip's duration are all derived from that list. The rule follows 49 CFR 395.3 for one property-carrying driver:

| Driving counter reaches | Stop | Resets |
|---|---|---|
| 60 hours in the cycle | 34 hours (restart) | all counters |
| 11 hours since the last rest | 10 hours (rest) | the 8-hour and 11-hour counts |
| 8 hours since the last break | 30 minutes (break) | the 8-hour count |

When limits are reached together the longest stop wins and ends the counts the shorter would have. No stop is taken at or after the destination, so a trip that ends exactly at a limit has none. A checkpoint reached exactly where a stop begins gets its arrival time, before the stop. Elapsed time is strictly increasing in driving time. The cycle step matters only for a trip of more than 60 hours at the wheel, which the app can be asked for only on the longest cross-country runs.

The ranking is unchanged in outcome: every route in a plan has the same schedule, so less driving is always an earlier arrival, and step 5 (travel time) has no tolerance. What changes is the size of the time difference it reports, which is door-to-door time. A few minutes of TomTom's estimate either side of a limit moves an arrival by 10 hours (the step is real under the rule and sharp under the model), and it only decides between routes already tied on safety. A test pins the equivalence.

A stop's weather is read like a checkpoint's (section 1) at the worst of its start, each hour inside it and its end, and is shown with the stop. The route summary (section 2) and the ranking (section 3) are built from checkpoints only: a parked truck covers no miles, so a stop's level never enters the miles at each level, the average risk or any ranking step.
