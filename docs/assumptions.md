# Assumptions

Readings and limits the app applies where the assessment is silent. The rules for weather risk and ranking are in [logic.md](logic.md); this file covers the trip request.

## Trip request

- **Departure** is accepted from 15 minutes ago up to 48 hours ahead. A departure typed as "now" arrives slightly in the past, so the 15 minutes are accepted as given; anything earlier is rejected. The 48 hours match the longest forecast the heatmap slider shows. The departure carries a UTC offset, and every ETA the API returns is a UTC instant.
- **Load weight** must be more than 0 and at most 80,000 lb, the US federal gross vehicle weight limit. It is sent to the routing provider in kilograms, because the provider reads the number as kilograms without checking it.
- **Origin and destination** must be valid coordinates and different points.
- **Checkpoint spacing** is 10, 25 or 50 miles.

## Routes and checkpoints

- **Every route ends with a checkpoint at the destination,** so the arrival ETA is shown. The risk rules accept a final checkpoint that stands for no miles ([logic.md](logic.md#2-route-summary)).
- **ETAs are driving time only,** from the provider's typical speeds: no live traffic and no rest breaks.
- **Routes the provider returns are shown as given.** Only a route made by sending the truck through a via-city must overlap every other route by less than half; the provider's own alternatives skip that check.
- **A via-city comes from a fixed list of 45 US hubs,** chosen by geometry alone, so a via route can include a local detour into the city.
