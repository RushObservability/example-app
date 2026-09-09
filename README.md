# example-app

A small instrumented microservice suite used to generate demo telemetry for Rush.
Six Express services call each other through a gateway; a seventh process drives
traffic against it. Everything is OpenTelemetry-instrumented via `tracing.js`,
which exports traces and metrics over OTLP.

This is synthetic sample code. It is not a library, and nothing here is intended
for production use.

## One image, seven processes

All services ship as a single container image. They differ only in the entrypoint
script and a few environment variables, so `docker compose` overrides `command`
per service rather than building seven images.

| Service | Command | Port |
|---|---|---|
| gateway | `node --require ./tracing.js gateway.js` | 3000 |
| articles | `node --require ./tracing.js articles.js` | 3001 |
| notifications | `node --require ./tracing.js notifications.js` | 3002 |
| users | `node --require ./tracing.js users.js` | 3003 |
| payments | `node --require ./tracing.js payments.js` | 3004 |
| media | `node --require ./tracing.js media.js` | 3005 |
| traffic | `node generate-traffic.js 5 3600` | — |

The image `CMD` defaults to the gateway.

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
