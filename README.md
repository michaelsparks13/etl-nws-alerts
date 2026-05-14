<h1 align='center'>ETL-NWS-Alerts</h1>

<p align='center'>Bring active National Weather Service alerts (Red Flag Warnings, Fire Weather Watches, Flash Flood Warnings, severe thunderstorm and tornado warnings, winter weather alerts, etc.) into the TAK ecosystem.</p>

<p align='center'>Built for fire-line, SAR, and emergency-management operators who need a single common-operating-picture layer that shows where, when, and how severe an active NWS alert is — without leaving ATAK / WinTAK.</p>

## What it does

- Polls `GET https://api.weather.gov/alerts/active` on a CloudTAK schedule and filters by state/territory area code, event type, and minimum severity.
- Maps each alert to a styled GeoJSON Feature: stroke/fill colored by CAP severity (Extreme → red, Severe → orange, Moderate → yellow, Minor → blue, Unknown → gray), the event + first segment of `areaDesc` as the callsign, and `onset`/`effective` → CoT `start`, `ends`/`expires` → CoT `stale`.
- Resolves zone polygons for alerts that ship with `geometry: null` (most fire-weather-zone Red Flag Warnings) by fetching `affectedZones[]` from the NWS zones API. This is opt-in (`NWS_ResolveZoneGeometry`) because it multiplies API calls.
- Suppresses `messageType: "Cancel"` messages (per CAP semantics, a Cancel tells consumers to drop the prior alert — it should not appear as its own feature).
- Splits MultiPolygon alerts into per-polygon features with `-N` id suffixes, matching the convention used in `etl-cotrip-incidents` and `etl-cotrip-weather`.

## Development

The [api.weather.gov OpenAPI spec](https://www.weather.gov/documentation/services-web-api) documents the upstream NWS feed. NOAA requires a descriptive `User-Agent` on all requests; provide one via `NWS_UserAgent` (e.g. `"(your-org-name, contact@example.com)"`).

This task is meant to run in an AWS Lambda-optimized Docker container managed by CloudTAK. For local development you can install dependencies and run the task directly:

```sh
npm install
```

The task uses a JSON `.env` file (matching the `@tak-ps/etl` convention used in `etl-cotrip-weather` and other dfpc-coe ETLs):

```json
{
    "ETL_API": "http://localhost:5001",
    "ETL_LAYER": "19"
}
```

Run against a local CloudTAK ETL server with `ts-node` or via the built bundle:

```sh
npx ts-node task.ts
# or
npm run build
cp .env dist/
node dist/task.js
```

To preview the FeatureCollection the task would submit without sending it (no CloudTAK server required), set `DRY_RUN=1`:

```sh
DRY_RUN=1 NWS_Area=CO npx ts-node task.ts
```

Layer config is read from the standard CloudTAK environment block; for local debugging the same keys are read from the JSON `.env`. Set `DEBUG: true` for verbose per-alert logging plus the submitted FeatureCollection.

### Tests

`npm test` runs the test suite via Node's built-in test runner against saved NWS fixtures in `test/fixtures/`. Covers the property mapping, severity / event / messageType filtering, and the null-geometry → zone-resolution path.

> **Note for reviewers:** the reference dfpc-coe ETLs (`etl-cotrip-weather`, `etl-cotrip-incidents`, `etl-active911`) ship with `scripts.test = "exit 0"` and no test directory. This ETL adds a small `node --test` suite because the NWS feed has enough wrinkles (null-geometry alerts, Cancel-message semantics, severity ordering) that they're worth pinning. The dependency footprint stays zero — `node --test` is built-in. Happy to strip if it diverges too far from the family conventions.

### Deployment

Deployment is automatic from the `dfpc-coe/etl-nws-alerts` GitHub repository to the DFPC AWS Environment. Github actions will build and push docker containers on every version tag pushed to main. The reference workflow lives in `.github/workflows/ecr_etl.yml` and matches the workflow in the rest of the dfpc-coe ETL family.

## Layer Configuration

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `NWS_Area` | string | yes | — | Comma-separated NWS area codes (US state/territory codes). Example: `CO` or `CO,WY,UT,NM`. |
| `NWS_Events` | string[] | no | `[]` | Allow-list of event names. Case-sensitive — must match the NWS event name exactly (e.g. `Red Flag Warning`). Empty = all events. |
| `NWS_MinimumSeverity` | enum | no | — | One of `Extreme`, `Severe`, `Moderate`, `Minor`, `Unknown`. Drops anything strictly below. |
| `NWS_ResolveZoneGeometry` | boolean | no | `false` | When an alert has null geometry, fetch its `affectedZones` polygons. Capped at 25 zones per alert. |
| `NWS_UserAgent` | string | no | `(etl-nws-alerts, https://github.com/dfpc-coe/etl-nws-alerts)` | NOAA requires a descriptive UA; operators should set this to their own org + contact. |
| `DEBUG` | boolean | no | `false` | Verbose logging including the submitted FeatureCollection. |

## Operational notes

- **NWS `properties.id` is not stable across the alert lifecycle.** When an alert is updated, a *new* id is issued and the prior id appears in `references[].identifier`. However `/alerts/active` only returns the currently-effective version of each alert, so re-running this ETL on schedule will naturally replace prior versions on the layer (provided the CloudTAK layer's stale time is short enough that superseded features expire between runs).
- The NWS `Cache-Control` on `/alerts/active` is `max-age=30`; do not schedule this layer below 30s. Zone endpoints cache for ~30 days, so zone-resolution overhead amortizes well across runs.
- A typical run over `area=CO,WY,UT,NM` with zone resolution enabled completes well inside a 60s serverless timeout. If you broaden to nationwide coverage with zone resolution on, expect 10–60s and watch for the documented 5-second rate-limit cooldown.
