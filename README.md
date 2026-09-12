# example-app

A small instrumented microservice suite used to generate demo telemetry for Rush.
Six Express services call each other through a gateway; a seventh process drives
traffic against it. Those services use `tracing.js` to export traces and metrics
over OTLP. A separate flight-data generator sends structured JSON logs to Rush.

This is synthetic sample code. It is not a library, and nothing here is intended
for production use.

## Database activity and CPU profiles

The dev stack includes simulated database calls in three services. No database
servers are contacted by these calls. Their client spans carry both legacy and
current OpenTelemetry database attributes, plus `demo.synthetic=true`.

| App | Simulated dependencies |
|---|---|
| articles | PostgreSQL `content-postgresql.example`, Redis `content-cache-redis.example` |
| users | PostgreSQL `identity-postgresql.example`, Redis `identity-cache-redis.example` |
| payments | MySQL `ledger-mysql.example` |

Existing traffic exercises these queries, with slow queries and occasional
errors. In **Services**, open one of these apps to see database time and
dependencies. Explore traces contain client spans such as `SELECT users` and
`INSERT transactions`. This is client-side DB usage, not database-server metrics
such as buffer hits or connection counts from a real server.

The same three apps run the built-in V8 CPU sampler. These are measurements of
the example processes, not invented profile stacks. Each mock DB result adds
about 8 ms of row decoding so `processDatabaseResult` and `decodeDatabaseRows`
appear under load. Sleeping for the simulated database does not create CPU
samples. Sampling covers the main V8 thread, not worker threads or the imaginary
database server, and does not provide exact trace/span attribution.

Update and restart query-api and frontend with profiling support first. The
API runs on the host at port 8080. From the parent workspace:

```sh
# If default requires ingest authentication, use an ingest key scoped to default
# with profiles permission. Omit this when local dev permits unauthenticated ingest.
read -r -s RUSH_PROFILE_API_KEY
export RUSH_PROFILE_API_KEY
make dev-up

# With infrastructure already running, rebuild just the example apps instead:
make dev-demo
make dev-demo-logs
```

Open **Observe → Profiles**, select `articles`, `users`, or `payments`, and use
**CPU from sample counts**. Allow about 30 seconds of traffic and export time.
Keep query-api and frontend in your own terminals as before.

Profiles go directly to `/v1development/profiles` as OTLP v1.10.0 protobuf. The
older dev OTel Collector remains responsible for traces and metrics, not profiles.
The exporter uses an in-process inspector session and opens no debugger port.
Idle samples are discarded. CPU estimates are sample counts times a 1 ms period.
Collection pauses during uploads; a failed upload drops that window and logs a
warning, keeping buffering bounded during an API outage.

| Variable | Terminal default | Dev Compose default |
|---|---|---|
| `RUSH_PROFILING_ENABLED` | `false`, opt in with `true` | `true` for the three DB apps |
| `RUSH_PROFILE_ENDPOINT` | `http://localhost:8080` | `http://host.docker.internal:8080` |
| `RUSH_PROFILE_TENANT` | `default` | fixed to `default`, matching demo traces |
| `RUSH_PROFILE_API_KEY` | falls back to `RUSH_API_KEY` | same fallback |
| `RUSH_PROFILE_INTERVAL_SECS` | `10`, allowed 1 to 60 | same |
| `DEMO_DB_CPU_MS` | `8`, clamped to 0 to 50 | same |

Set `DEMO_DB_CPU_MS=0` to remove the added CPU load or
`RUSH_PROFILING_ENABLED=false` to stop sampling, then run `make dev-demo`.
Use HTTPS for any profile endpoint outside trusted local development. Never
commit an API key. The API's tenant and signal permissions still apply.

Implementation references: [Node's CPU profiler](https://nodejs.org/api/inspector.html#cpu-profiler)
and [OpenTelemetry database spans](https://opentelemetry.io/docs/specs/semconv/db/database-spans/).

## One image, multiple processes

All services ship as a single container image. They differ only in the entrypoint
script and a few environment variables, so `docker compose` overrides `command`
per service.

| Service | Command | Port |
|---|---|---|
| gateway | `node --require ./tracing.js gateway.js` | 3000 |
| articles | `node --require ./tracing.js articles.js` | 3001 |
| notifications | `node --require ./tracing.js notifications.js` | 3002 |
| users | `node --require ./tracing.js users.js` | 3003 |
| payments | `node --require ./tracing.js payments.js` | 3004 |
| media | `node --require ./tracing.js media.js` | 3005 |
| traffic | `node generate-traffic.js 5 3600` | — |
| flights | `node flights.js` | none |

The image `CMD` defaults to the gateway.

## Flight data for log views

The flight generator sends eight synthetic updates every five seconds to the
**default tenant**, using Rush's `/api/v1/ingest/logs` JSON endpoint. It does not
need the OTel Collector or Vector. The API and ClickHouse must be running.

From the parent workspace:

```sh
make dev-up             # Includes flights alongside the existing example stack
# Or start only the flight generator with existing infrastructure:
make dev-flights
make dev-flights-logs   # Check delivery
make dev-flights-stop   # Stop generating flight data
```

To run in your terminal instead, use Node 20.3+ from this directory. No package
installation is needed for this script:

```sh
node flights.js          # Continuous updates; Ctrl+C stops
node flights.js --once   # Send one batch of eight logs and exit
```

If the default tenant requires ingest authentication, set `RUSH_API_KEY` to an
ingest key belonging to **default** with **logs** permission before running
either command. The Docker target also reads the workspace `.env`. An API key
for another tenant will be rejected. Do not disable authentication for the demo.

`RUSH_API_ENDPOINT` defaults to `http://localhost:8080` for terminal runs. The
Compose service uses `http://host.docker.internal:8080`. Set
`FLIGHTS_INTERVAL_SECS` to change the cadence, from 1 to 3600 seconds.

In **Settings → Log views**, choose **New log view → Use flight example → Save
view**, then select **Flights** in **Explore → Logs**. It uses this layout:

| Heading | Field |
|---|---|
| Time | `timestamp` |
| Airline | `log.airline` |
| Flight number | `log.flight_number` |
| Status | `log.status` |

The base filter is `type=event_data`. Add `dataset=flights` to the base if you
have other event datasets. Search within the view with `status=Delayed`,
`origin=SFO`, or `airline="Example Air"`.

Records also include `destination`, `gate`, `delay_minutes`,
`scheduled_departure`, `observed_at`, and `synthetic=true`. The JSON message
contains the same fields, so columns such as `body.airline` work too. The service
name is `flight-data-demo`. These are fictional flights with rotating statuses,
not live airline data.

On failure the generator retries one pending batch with backoff capped at 60
seconds. It does not accumulate more batches during an outage. Retries can
duplicate a batch if an acknowledgement is lost; restarting drops the pending
batch. `--once` exits unsuccessfully if the API rejects the batch.

```sh
npm run test:flights
```

## Image

```
ghcr.io/rushobservability/example-app:<version>
```

Built for `linux/amd64` and `linux/arm64`.

## Configuration

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint |
| `SERVICE_NAME` / `SERVICE_VERSION` | Resource attributes reported for the service |
| `PORT` | Listen port |
| `RUSH_LOG_EVENTS` | Emit structured log events alongside spans |
| `GATEWAY_URL` | Target for the traffic generator |
| `ARTICLES_URL`, `MEDIA_URL`, `NOTIFICATIONS_URL`, `PAYMENTS_URL`, `USERS_URL` | Downstream addresses used by the gateway |

## Releasing

Bump `version` in `package.json` and merge to `main`. The release workflow builds
the multi-arch image, pushes it to GHCR, and creates the matching `v<version>` tag
and GitHub release. A merge that touches `package.json` without changing the
version is skipped rather than failed.

## Local development

```sh
npm install
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
  SERVICE_NAME=gateway PORT=3000 \
  node --require ./tracing.js gateway.js
```
