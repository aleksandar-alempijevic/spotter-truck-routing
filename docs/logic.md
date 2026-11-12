# Risk and ranking logic

How the app turns weather into a risk level, a route's checkpoints into a summary, and route summaries into a recommendation. The code is the plain-Python package [backend/risk_rules/](../backend/risk_rules/), tested in `backend/tests/test_risk_levels.py`, `test_route_summary.py`, `test_route_ranking.py` and `test_risk_rules_boundary.py`. The package imports only the standard library, so it can be read and tested without Django, and the API layer calls it, never the reverse.

Units throughout are the assessment's: sustained wind in mph, rain and snow in inches per hour, load in pounds, distances in miles. Converting a weather provider's fields into these units happens before this package is called.

## 1. Risk level at one checkpoint

`classify_weather(reading, load_lb)` takes a reading (sustained wind, rain rate, snow rate) and the load weight, and returns the level, the condition that decided it, and whether a load rule raised it.

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

**Combining conditions.** The checkpoint takes the worst of wind (after load rules), rain and snow. When more than one condition has the worst level, wind is named before rain and rain before snow. If a load rule lifted the level above what the weather alone gives, the condition is wind and the result says so (`load_raised`), which is what lets the UI explain a Severe at 38 mph.

**Gusts** are not part of the reading. They are shown beside the level and never change it: the assessment says "wind", read here as sustained wind.

**Inputs must be real measurements.** Every field must be a finite number of at least 0; anything else (NaN, infinity, a negative) is rejected. Missing weather is never passed in as a number: the caller leaves the checkpoint's level absent.

## 2. Route summary

`summarize_route(total_miles, checkpoints)` takes a route's length and its checkpoints, each a mile mark and a level (or none), and returns the miles at each level, the miles with no forecast, the average risk and the number of checkpoints with a forecast.

- **Each checkpoint stands for the road from its mark up to the next mark**; the last one stands for the road to the end of the route. A checkpoint at the destination stands for no miles.
- **Marks must start at mile 0, strictly ascend and not pass the route's end.** A route that violates this is rejected, not repaired, so no road goes unattributed.
- **Average risk** scores Low 0, Moderate 1, High 2, Severe 3, No Travel 4 and averages by miles, so a long segment counts more than a short one. No Travel's score only matters among routes that all have No Travel miles; those rank last regardless.
- **No forecast.** A checkpoint past the forecast range has no level. Its miles are counted separately, are left out of the level miles and the average, and are never treated as Low. A route with no forecasted miles at all has no average risk.

## 3. Ranking

`rank_routes(candidates, checkpoint_interval_miles)` takes two or three routes (id, travel time, total miles, summary) and the checkpoint spacing the request used (10, 25 or 50 miles).

The routes are filtered in the assessment's order of preference. At each step the routes within a tolerance of the best value stay in; the rest drop out of the contest for first place:

| Step | Keeps routes with | Tolerance |
|---|---|---|
| 1. No Travel | fewest No Travel miles | none |
| 2. Severe | fewest Severe miles | none |
| 3. High | High miles no more than the best plus one checkpoint interval | one interval |
| 4. Average risk | average risk no more than the best plus 1/N | 1/N |
| 5. Travel time | shortest travel time | none |
| 6. Miles | fewest total miles | none |
| 7. Route id | smallest id | none |

The first step that leaves a single route decides first place, and the ranking reports which step that was. Second and third place repeat the same steps over the routes not yet placed. The result is the same whatever order the routes arrive in.

**Why these tolerances.** The smallest difference the data can show is one checkpoint changing by one level, and a difference that size cannot be told apart from forecast noise. Within it, the next criterion decides, so travel time decides whenever the safety difference is that small, and never overrides a real Severe or High difference. Severe has no tolerance: one more Severe checkpoint always loses, however much faster the route is.

**No Travel.** The assessment's list leaves No Travel out. Any route with No Travel miles ranks below every route without them, and among routes that all have them the one with the fewest No Travel miles ranks first. A first-ranked route that has No Travel miles is not recommended: the result's `recommended_id` is empty and the UI should say no route is safe to recommend.

**N in the average-risk tolerance** is the number of checkpoints with a forecast that stand for more than zero miles, taken from the route that has the fewest of them among the routes still in the contest. The fewest gives the widest, most forgiving tolerance, because that route's average moves most per checkpoint. A route with no average risk (no forecasted miles) counts as worse than any average, so it drops at step 4 whenever another route has one.

**Interplay of steps 3 and 4.** One High checkpoint among N raises the average by 2/N, more than the 1/N tolerance. A one-interval High gap therefore reaches the time step only when the routes' average risk is also within tolerance, for example when the other route has comparable Moderate miles.

**Tolerance edges and rounding.** A gap of exactly one interval is a tie. Segment miles are differences of floating-point marks, so a gap that is one interval on paper can come out a hair either side. Two values closer than `FLOAT_MARGIN` (0.000001, in miles, risk points or seconds) count as equal. Real differences are many orders of magnitude larger than the margin.

**No-forecast miles** do not enter any step, so a route that is mostly past the forecast range is compared on the part that has a forecast. The ranking returns each route's no-forecast miles so the UI can show them.

**Output.** For each route in rank order: its rank, its no-forecast miles, and, for every route except the first, the step at which it left the contest for first place and its differences from the first route (travel time in seconds, No Travel, Severe and High miles, and average risk; each is the route's value minus the first route's). The UI uses these for lines like "+38 min, avoids 50 Severe miles" and to show which values were ties: a route that survived a step was within tolerance on it. The first route's deciding step names the reason for the recommendation.

A cap on how much extra time a safer route may cost is not part of the assessment and is not applied.

## 4. What the callers must supply

- Weather in the units above, with no forecast represented as an absent level.
- Checkpoints with a mark at mile 0, ascending, inside the route.
- Unique route ids, two or three routes per ranking, and one checkpoint interval for the request.
- Travel time in seconds.
