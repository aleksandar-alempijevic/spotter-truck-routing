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
- **A via-city comes from a fixed list of 45 US hubs,** chosen by geometry alone, so a via route can include a local detour into the city. Up to six cities are tried, so "no distinct third route" means those six did not work, not that no third route exists.

## Address search

- **Suggestions are US places of any type** (address, street or city), each with its full label including the state, so the driver picks the right one from the list instead of the app guessing from a partial query. A street without its state matches buildings in several states, and the labels show which is which.
- **A suggestion without a time zone is dropped,** because the departure time the driver types is read in the origin's time zone.
- **Typed text must be 3 to 100 characters** after trimming; shorter text is rejected without calling the provider.
