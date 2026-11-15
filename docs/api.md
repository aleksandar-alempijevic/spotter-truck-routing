# API

The backend's HTTP surface: the endpoints, what they accept and return, the error contract, and the policy every call to a data provider follows. The interactive reference is at `/api/docs` on a running server, and the frontend's types are generated from the same OpenAPI schema. How routes and weather are computed is in [architecture.md](architecture.md).

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Returns `{"status": "ok"}` |
| `POST /api/routes` | Up to three truck routes with checkpoints and ETAs ([below](#the-routes-request-and-response)) |
| `POST /api/weather` | The forecast, risk levels, summaries, ranking and corridor grid for those routes ([below](#the-weather-request)) |
| `GET /api/address-search?q=…` | US place suggestions ([below](#address-search)) |

## The routes request and response

`POST /api/routes` takes origin and destination coordinates, a departure instant, the load in pounds, the checkpoint spacing and an optional `rest_breaks` flag, false when omitted. The response has up to three routes, fastest first, with ids `route-1` to `route-3` numbered from that order. Each route has its travel time in seconds (`travel_time_seconds`, departure to arrival), its driving time (`driving_seconds`), its `stops`, its miles, checkpoints (`mile`, `lat`, `lon`, `eta`), its line for the map as `[lon, lat]` pairs, its `source` (`provider` or `via_city`) and its `via` city. A `shortfall` with a reason and a message says why there are fewer than three: `no_distinct_alternative`, or `fill_incomplete` when the search for another route failed or ran out of its time budget; the message names the cities that were tried. The response also echoes whether the ETAs include rest breaks (`breaks_applied`).

**Time budget.** Each TomTom call may take 50 s, and one planning request has one 120 s deadline covering the base call and the fill. When the budget runs out during the fill, the routes in hand are returned with the `fill_incomplete` shortfall; during the base call it is a 504.

## The weather request

`POST /api/weather` takes back a subset of the routes response: `load_lb`, `checkpoint_interval_miles`, and per route `id`, `travel_time_seconds`, `total_miles`, `checkpoints` and `stops` (not `line`, `source`, `via` or `driving_seconds`). With rest breaks on, the travel time and ETAs already include the stops. The corridor is derived from the checkpoint positions, so no route line travels back; three of the longest test routes (about 10,500 miles together) make about 1,050 checkpoints at 10-mile spacing, roughly 100 kB of JSON. Each checkpoint and stop reading in the answer carries the conditions, `gust_warning` and the risk ([architecture.md](architecture.md#weather)).

The schema classes `PlanParams` and `RouteCore` are that subset and own its input bounds. Beyond the trip limits in [assumptions.md](assumptions.md#trip-request), they allow at most 600 checkpoints per route, at most 100 stops per route (each at most 48 hours), a `travel_time_seconds` of at most 30 days, every `mile` and `total_miles` at most 30,000, and every checkpoint `eta` and stop `starts_at` a timezone-aware instant between 30 days before now and 48 hours plus 30 days after now (`DEPARTURE_HORIZON` and `STOP_HORIZON` in `api/schemas.py`). A past time is accepted and simply has no forecast, which lets a weather retry of a plan left open for hours pass. `RoutesIn` and `WeatherIn` both extend `PlanParams`, so the two requests share one definition of the plan fields; `WeatherIn` takes `routes: list[RouteCore]` (up to three), and the weather response echoes the plan as a nested `plan: PlanParams`. Extra fields in the body are ignored.

### Validation

Validation runs before any outbound call and answers 422 `validation_error`, with two exceptions that have codes of their own:

- **`outside_service_area`:** a checkpoint or stop outside the service box ([assumptions.md](assumptions.md#service-area)).
- **`too_many_locations`:** a plan that needs more than 1,800 forecast locations (three Open-Meteo minute windows of 600, the most that fits the deadline). `plan_locations(max_locations=…)` raises when the total passes that number, and earlier, as a cheap path, when the checkpoint cells or the corridor's display cells alone do. It is raised as Ninja's own validation error, so it takes the ordinary 422 path.

The other rules: unique route ids; the first mark at 0, marks strictly ascending and not past `total_miles` (at least as strict as `summarize_route`, which a table test checks); each mark gap at most the interval; and consecutive checkpoints no farther apart in a straight line than their mark gap (plus 5% and a quarter mile) and no farther apart in longitude than that distance can cover at their latitude (`longitude_span_coverable` in `weather/grid.py`, which also rejects a short hop across the antimeridian that would span the whole map in the planar sweep). These last two keep a hand-built body from making the corridor walk a huge area. Stops are validated like checkpoints: past the route's end, out of time order, starting outside the planning window, of no length or of an unknown kind is a `validation_error`.

## Address search

`GET /api/address-search?q=…` returns US place suggestions from Geoapify's autocomplete with `filter=countrycode:us`.

- **City first.** Text with no digit is searched with `type=city` first, which keeps "Salt Lake" from answering with a town in New Mexico; if that finds nothing, one more search runs without a type, so a depot name stays findable. A failed first call is an error, with no second call. Text containing a digit keeps the untyped search, so a suggestion can be an address, a street or a city.
- **Input and output.** The text is trimmed and must be 3 to 100 characters, checked before any provider call (otherwise 422). The response is `{suggestions: [{label, lat, lon, timezone}], attribution: {text, url}}`: `label` is the full text with the state, `timezone` an IANA name for converting a typed departure time, and the attribution (`Powered by Geoapify`) is what the free plan requires the UI to show. A suggestion without a label, coordinates or time zone is dropped, and no match is an empty list, not an error.
- **Timing.** Each Geoapify call has a 10 s connect limit and a 10 s read limit and is not retried, so one call can take close to 20 s, and a city search followed by the untyped search can take longer than 20 s. A timeout is a 504 and a refused connection a 502. A search with a number first and no place named is slow (7 to 9 s measured), and no filter or type speeds it up.
- **Key.** `GEOAPIFY_API_KEY`; a missing one is a 503 `provider_not_configured`.

## Errors

Every endpoint's errors have one body, `{code, message}`, where `code` is one of a closed set (`validation_error`, `not_found`, `method_not_allowed`, `internal_error`, `no_route`, `provider_timeout`, `provider_unavailable`, `provider_limited`, `provider_not_configured`, `provider_malformed_response`, `provider_error`, `outside_service_area`, `too_many_locations`) that a test ties to every error class, so the generated types carry it as a union.

| Status | When |
|---|---|
| 422 | Validation, including `outside_service_area` and `too_many_locations`; no route between the points (`no_route`) |
| 504 | A provider timeout |
| 502 | An upstream failure or a malformed answer |
| 503 | A provider rate limit, or a missing key: "A data provider is not configured on this server." |
| 404, 405, 500 | Unknown path, wrong method, unexpected exception |

- **The code comes from the error's type,** set where it is raised (`SPECIFIC_VALIDATION_CODES` in `api/errors.py`), never from the message text. A new error status enters through `API_ERRORS` (`api/errors.py`) or a provider error class with a code in the closed set, never through `HttpError` or a framework default.
- **Every error the API's own routing and endpoints produce has this body.** A request body that is not JSON, or over Django's upload limit, is a 422 `validation_error`; an unexpected exception is a 500 `internal_error` whose detail goes to the log, never to the client. `api/middleware.py` judges the body, not the layer: any error status under `/api/` whose body is not a JSON object with exactly `code` and `message` (Django's 404 page, Ninja's plain-text 405, a `Http404` inside an endpoint) is replaced, and a 405 keeps its `Allow` header. The middleware's 500 plus a warning for any other shape is an alarm for a gap, not a mapping to rely on. Every operation declares the 404, 405, 422 and 500 responses.
- **Outside the guarantee:** Django's host check (a disallowed `Host`) and the hosting edge can answer in another shape, so a client treats an error without a parsable `{code, message}` as an unknown failure.
- **Messages carry no URL, key or provider text** and name no single provider.

## Provider calls

`providers/outbound.py` holds the policy every provider call follows:

- **One HTTP client per API request,** opened inside the request's coroutine and closed on every exit, including the cancellation Django's ASGI handler applies on a client disconnect.
- **At most 4 calls in flight** per client, the one concurrency cap.
- **One retry** on a timeout, a transport error or a 5xx, never on a 4xx. A call made with `retry=False`, as address search is, is made once.
- **Connect tries** follow a per-call `ConnectPolicy`: one 10 s connect per try unless the caller asks for more. Only Open-Meteo does ([architecture.md](architecture.md#quota-waiting-and-deadline)).
- **Provider-neutral errors** with no URL, key or upstream body in them. Each error class carries its code and its HTTP status, and the API's error handler and declared error responses are read from the classes. A 429's error carries the provider's `Retry-After` as the number `retry_after_s`, never in its message; a 401 or 403 carries none.
- **GET and form POST.** Besides GET, `post_form` sends a form-encoded body under the same policy, because the weather request does not fit in a URL.

The adapters: `tomtom.py` is the TomTom truck-mode adapter, where kilograms exist; `geoapify.py` is the Geoapify autocomplete adapter; `openmeteo.py` is the Open-Meteo adapter, which needs no key, applies the 7:1 snow ratio, checks the unit strings and the hourly stamps (the first and last are parsed, the rest checked by shape), parses off the event loop, and keeps a null as absent. Geoapify and Open-Meteo each define `ATTRIBUTION_TEXT` and `ATTRIBUTION_URL`.
