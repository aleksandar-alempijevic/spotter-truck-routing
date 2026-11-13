# Assumptions

Readings and limits the app applies where the assessment is silent. The rules for weather risk and ranking are in [logic.md](logic.md); this file covers the trip request, the routes and the weather.

## Trip request

- **Departure** is accepted from 15 minutes ago up to 48 hours ahead. A departure typed as "now" arrives slightly in the past, so the 15 minutes are accepted as given; anything earlier is rejected. The 48 hours match the longest forecast the heatmap slider shows. The departure carries a UTC offset, and every ETA the API returns is a UTC instant.
- **Load weight** must be more than 0 and at most 80,000 lb, the US federal gross vehicle weight limit. It is sent to the routing provider in kilograms, because the provider reads the number as kilograms without checking it.
- **Origin and destination** must be valid coordinates and different points.
- **Checkpoint spacing** is 10, 25 or 50 miles.

## Routes and checkpoints

- **Every route ends with a checkpoint at the destination,** so the arrival ETA is shown. The risk rules accept a final checkpoint that stands for no miles ([logic.md](logic.md#2-route-summary)).
- **ETAs are driving time only.** The request asks TomTom for traffic (`traffic=true`) at the departure time, so the times are TomTom's time-of-day prediction for that departure, not a fixed typical speed. Rest breaks are not included. How much traffic changed the ETAs has not been measured separately.
- **Routes the provider returns are shown as given.** Only a route made by sending the truck through a via-city must overlap every other route by less than half; the provider's own alternatives skip that check.
- **A via-city comes from a fixed list of 45 US hubs,** chosen by geometry alone, so a via route can include a local detour into the city. Up to six cities are tried, so "no distinct third route" means those six did not work, not that no third route exists.

## Address search

- **Suggestions are US places of any type** (address, street or city), each with its full label including the state, so the driver picks the right one from the list instead of the app guessing from a partial query. A street without its state matches buildings in several states, and the labels show which is which.
- **A suggestion without a time zone is dropped,** because the departure time the driver types is read in the origin's time zone.
- **Typed text must be 3 to 100 characters** after trimming; shorter text is rejected without calling the provider.

## Weather

- **The weather comes from Open-Meteo's `best_match` model** (hourly, 96 hours from the current UTC hour), which is HRRR for about 42 hours and then GFS over the US. The 7:1 snow-to-water ratio is Open-Meteo's fixed assumption, not a forecast.
- **A forecast is read for the 0.1° cell (about 7 miles) holding the checkpoint.** Moving a point by 0.1° changed a wind level in about 2% of hours.
- **Wind is interpolated between hours; gust, rain and snow are read from the first stamp at or after the ETA,** because the docs define them over the hour before the stamp. This rests on the documentation: live comparison with 15-minute data was inconclusive.
- **An ETA up to one hour before the first stamp reads the first stamp.** A departure typed as "now" can be up to 15 minutes in the past, and that stamp describes exactly the preceding hour.
- **Past the last stamp, or where a needed value is missing, there is no forecast.** The miles are counted separately and never as Low. A route with no forecast at any checkpoint has no average risk.
- **If a route's checkpoints have different mile-0 ETAs** (only a hand-built body can), `departure` is the earliest and each checkpoint's ETA is still used as given.
- **The heatmap shows the five risk levels with the load rules applied,** not raw weather, so it matches the checkpoints and the legend.
- **Hour 0 of the slider is the top of the request's UTC hour,** and the response marks the departure separately.
- **The corridor is the area within about 25 miles of the segments between consecutive checkpoints,** on 0.5° cells (about 35 by 27 miles). At 50-mile spacing a segment can cut a road bend; the coarse cells absorb that.
- **The forecast cache is keyed by the forecast cell and the series' first stamp,** and an entry is used only while that stamp is the current UTC hour. This stands in for Open-Meteo's model-run time, which the response does not give. The cache lives in one process.
- **Open-Meteo is free without a key, per IP:** 600 locations a minute, 5,000 an hour and 10,000 a day, one location counting as one call, and a refusal answers 429 with the seconds left in the minute. Where the app is hosted shares that quota with other users of the host's address, so any trip can wait or fail with a 503. The worst measured cold trip at 25-mile spacing is about 515 locations and needs no wait on a fresh window; **10-mile spacing on a long trip (676 to 1,051 locations in the measurements) can take about a minute**, because the minute window has to run out once, and the UI is to say so.
- **A weather request that needs more than 1,800 forecast locations is refused,** the most that three minute windows can serve inside the 150 s deadline.
- **Open-Meteo's free tier is for non-commercial use and requires attribution (CC BY 4.0);** the response carries the credit text and link, and the UI is to show it. The use here is an assessment.
