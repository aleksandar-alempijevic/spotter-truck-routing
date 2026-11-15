# Assumptions

Readings and limits the app applies where the assessment is silent. The rules for weather risk and ranking are in [logic.md](logic.md); this file covers the trip request, the routes and the weather. Measurements that bear on these choices are in [performance.md](performance.md).

## Trip request

- **Departure** is accepted from 15 minutes ago up to 48 hours ahead. A departure typed as "now" arrives slightly in the past, so the 15 minutes are accepted as given; anything earlier is rejected. The 48 hours match the longest forecast the heatmap slider shows. The departure carries a UTC offset, and every ETA the API returns is a UTC instant.
- **Load weight** is the cargo, more than 0 and at most 47,000 lb: with the assumed 33,000 lb rig below, that keeps the gross weight within the 80,000 lb US federal limit.
- **The risk load rules use the cargo,** the weight the driver entered, not the gross weight.
- **TomTom is sent the gross weight:** the cargo plus an assumed 33,000 lb for the empty tractor and trailer, in kilograms (TomTom reads the number as kilograms without checking it), because it checks road weight limits against the gross weight. The 33,000 lb is a typical figure, not the weight of the driver's rig.
- **Origin and destination** must be valid coordinates and different points.
- **Checkpoint spacing** is 10, 25 or 50 miles.
- **Every time on screen is read in the origin's time zone,** labelled with it, because the driver sets the departure there; the arrival is also shown in the destination's zone when that differs. A departure typed as a clock time is read in the origin's zone, and "leave now" is the current instant.

## Routes and checkpoints

- **Every route ends with a checkpoint at the destination,** so the arrival ETA is shown. The risk rules accept a final checkpoint that stands for no miles ([logic.md](logic.md#2-route-summary)).
- **ETAs are driving time only, unless the request turns rest breaks on** ([below](#when-rest-breaks-are-on)); the switch is off by default. The request asks TomTom for traffic (`traffic=true`) at the departure time, so the times are TomTom's time-of-day prediction for that departure, not a fixed typical speed. How much traffic changed the ETAs has not been measured separately.
- **Routes stay inside the US.** Every routing call asks TomTom to avoid border crossings, which TomTom treats as a preference, so the app keeps a route only when every country section TomTom reports is the US or a US territory with roads in the service area (`USA`, `PRI` for Puerto Rico, `VIR` for the US Virgin Islands; Alaska and Hawaii are `USA`), and drops a route whose country sections are missing. That TomTom labels Puerto Rico `PRI` and the US Virgin Islands `VIR` is assumed from their ISO 3166-1 codes, not observed. This holds for the provider's alternatives and for via-city routes. A trip with no road route inside the US, such as the lower 48 to Alaska, gets a `no_route` answer that says so.
- **Routes the provider returns are shown as given,** apart from the US rule above. Only a route made by sending the truck through a via-city must overlap every other route by less than half; the provider's own alternatives skip that check.
- **A via-city comes from a fixed list of 45 US hubs,** chosen by geometry alone, so a via route can include a local detour into the city. Up to six cities are tried, so "no distinct third route" means those six did not work, not that no third route exists.

## When rest breaks are on

A request with `rest_breaks` true adds the federal rest breaks to the ETAs and the trip's duration. The assessment does not ask for them, so they are an extra, off by default. The rule, how a stop's weather is read and how the ranking uses door-to-door time are in [logic.md](logic.md#4-rest-breaks-when-they-are-on). These readings apply only when breaks are on:

- **A1. The driver starts rested,** with 10 hours off behind them and no hours used in the current 7 or 8 days. There is no input for hours already driven.
- **A2. The driver only drives.** There is no inspection, loading, fuelling or waiting time, so the times are the earliest legal arrival, not a typical one. Under A2 every hour on duty is an hour driven.
- **A3. The 14-hour on-duty window is not modelled.** Under A2 a shift is 11 hours of driving plus a 30-minute break, 11.5 hours, so the window cannot bind.
- **A4. The cycle limit is 60 hours in 7 days,** the stricter of the 60-hour and 70-hour limits, because the carrier's operating schedule is not known. After 60 hours of driving the model takes a 34-hour restart. Alaska follows different limits (49 CFR 395.1(h)), which are not modelled, so a trip there is timed by the lower-48 rule.
- **A5. Each stop is taken exactly when its limit is reached,** at that point on the road. The map position can be open highway, not a truck stop or a town; the app has no places data. A break taken earlier would give the same total delay.
- **A6. One driver and a property-carrying truck,** with no sleeper-berth split, no short-haul exemption and no adverse-driving-conditions extension. The extension covers conditions not known before the trip, which a forecast made before departure arguably is.
- **A7. The 30-minute break resets the 8-hour count, and the 10-hour rest resets the 8-hour and 11-hour counts.** The break does not reset the 11-hour count.
- **A8. Speeds after a stop are TomTom's non-stop predictions.** After a 10-hour rest the truck is on later segments about 10.5 hours after the time of day TomTom assumed for them; re-routing each leg from its restart time would multiply the routing calls.

The screen says so: with breaks on, the panel and the stop list say that the times assume a rested start and no time except driving, and that a stop is placed where its limit is reached. The mode shown is the one the routes answer reports, not the state of the switch. Stops are in the list for every route and on the map for the selected route only. With breaks on, a trip of more than about a day at the wheel can end after the 96-hour forecast; those miles are counted as no forecast, never as Low.

## Address search

- **Suggestions are US places of any type** (address, street or city), each with its full label including the state, so the driver picks the right one from the list instead of the app guessing from a partial query. A street without its state matches buildings in several states, and the labels show which is which.
- **A suggestion without a time zone is dropped,** because the departure time the driver types is read in the origin's time zone.
- **Typed text must be 3 to 100 characters** after trimming; shorter text is rejected without calling the provider.

## Weather

### Forecast source and sampling

- **The weather comes from Open-Meteo's `best_match` model** (hourly, 96 hours from the current UTC hour), which is HRRR for about 42 hours and then GFS over the US. The 7:1 snow-to-water ratio is Open-Meteo's fixed assumption, not a forecast.
- **A forecast is read for the 0.1° cell (about 7 miles) holding the checkpoint.** Moving a point by 0.1° changed a wind level in about 2% of hours.
- **Wind is interpolated between hours; gust, rain and snow are read from the first stamp at or after the ETA,** because the docs define them over the hour before the stamp. This rests on the documentation: live comparison with 15-minute data was inconclusive.
- **An ETA up to one hour before the first stamp reads the first stamp.** A departure typed as "now" can be up to 15 minutes in the past, and that stamp describes exactly the preceding hour.
- **Past the last stamp, or where a needed value is missing, there is no forecast.** The miles are counted separately and never as Low. A route with no forecast at any checkpoint has no average risk.
- **If a route's checkpoints have different mile-0 ETAs** (only a hand-built body can), `departure` is the earliest and each checkpoint's ETA is still used as given.

### Heatmap and corridor

- **The heatmap shows the five risk levels with the load rules applied,** not raw weather, so it matches the checkpoints and the map key. Its colour ramp is a table of its own, measured against the colours a cell can lie over: Positron's land (`#f2f3f0`), water (`#c2c8ca`) and park (`#ddeadd`), and the plain fallback background (`#e9eef2`). Moderate through No Travel measure at least 3:1 against each of them, and each level is darker than the one before. Low is a quiet tint, exempt from the 3:1 rule. A different basemap style has not been measured.
- **Hour 0 of the slider is the top of the request's UTC hour,** and the response marks the departure separately.
- **The corridor is the area within about 25 miles of the segments between consecutive checkpoints,** on 0.5° cells (about 35 by 27 miles). At 50-mile spacing a segment can cut a road bend; the coarse cells absorb that.

### Service area

- **A weather request's checkpoints must lie in the service box (latitude 15 to 72, longitude -170 to -50).** It is the contiguous US with margin, Alaska (Nome and Utqiagvik inside), Hawaii and Puerto Rico (so a trip between addresses there gets its weather rather than a 422), not the US outline. Routes stay inside the US ([above](#routes-and-checkpoints)), so the box has no foreign road in mind. The Aleutians west of -170 are outside. Routes outside it, near a pole or across the antimeridian are rejected as a 422, because the corridor sweep treats longitude as planar. The routes endpoint's own inputs are not boxed: its addresses come from Geoapify's US filter and its routes from TomTom.

### Quota and cache

- **Open-Meteo is free without a key, per IP:** 600 locations a minute, 5,000 an hour and 10,000 a day, one location counting as one call, and a refusal answers 429 with the seconds left in the minute. The hosted app shares that quota with other users of the host's address, so any trip can wait or fail with a 503. **10-mile spacing on a long trip can take about a minute,** because it needs more than 600 locations and the minute window has to run out once; the form says so when 10 miles is chosen. Location counts are measured in [performance.md](performance.md#weather).
- **A weather request that needs more than 1,800 forecast locations is refused,** the most that three minute windows (Open-Meteo's, stated in the adapter) can serve inside the 150 s deadline.
- **The forecast cache is keyed by the forecast cell and the series' first stamp,** and an entry is used only while that stamp is the current UTC hour. This stands in for Open-Meteo's model-run time, which the response does not give. The cache lives in one process.
- **Open-Meteo's free tier is for non-commercial use and requires attribution (CC BY 4.0);** the response carries the credit text and link, and the UI shows it. The use here is an assessment.
