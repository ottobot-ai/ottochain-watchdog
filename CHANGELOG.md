# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.0.0...v1.1.0) (2026-03-01)


### Features

* add optional hypergraph health monitoring ([#16](https://github.com/ottobot-ai/ottochain-watchdog/issues/16)) ([80c58cb](https://github.com/ottobot-ai/ottochain-watchdog/commit/80c58cb526a4989fb9043a9da5f98f2adb8c77ff))

## [0.2.0] - 2026-02-27

### Changed

- **Renamed project**: `ottochain-health-monitor` → `ottochain-watchdog`
- **Refactored to consumer model**: Reads health data from Redis/Postgres (populated by services monitor) instead of polling nodes directly
- **Condition detectors are now pure functions**: Accept `HealthSnapshot` data instead of making HTTP calls
- **Event publishing**: Changed from HTTP POST to direct Postgres INSERT
- **Docker image**: Now `ghcr.io/ottobot-ai/ottochain-watchdog`

### Added

- Redis client (`ioredis`) for reading cached health data
- Postgres client (`pg`) for reading events and writing restart events
- `health-reader.ts` service for unified health data access with automatic fallback
- Configurable stale data threshold (`HEALTH_DATA_STALE_SECONDS`, default 60)
- Clear logging when using Redis vs direct HTTP fallback

### Removed

- **Monitoring configs**: `alertmanager/`, `grafana/`, `loki/`, `prometheus/` directories (moved to `ottochain-deploy/monitoring/`)
- **Docker compose stack**: `docker-compose.yml`, `docker-compose.exporters.yml` (compose configs now in `ottochain-deploy`)
- **Config generation scripts**: `scripts/` directory
- **Alert evaluation**: `src/alerts/` directory (Prometheus/Alertmanager handles alerting)
- **Webhook notifications**: `src/services/notify.ts` (Alertmanager handles notifications)
- **Independent health polling**: Watchdog no longer polls nodes directly except as fallback

### Migration Notes

- The watchdog now requires Redis and Postgres to be running (or falls back gracefully)
- Monitoring stack (Prometheus, Grafana, Alertmanager) is now deployed separately via `ottochain-deploy`
- Alert rules are now managed in `ottochain-deploy/monitoring/prometheus/alert_rules/`
- Environment variables `WEBHOOK_URL`, `MONITOR_URL`, `MONITOR_API_KEY` are no longer used

## [0.1.0] - 2026-02-06

### Added

- Initial release
- Fork detection across metagraph layers
- Snapshot stall detection (ML0 ordinal tracking)
- Unhealthy node detection
- SSH-based restart orchestration (individual, layer, full metagraph)
- Cooldown and rate limiting for restarts
- Event publishing to monitor service via HTTP
- Prometheus, Grafana, Alertmanager, Loki configuration
- Docker image build and deploy workflows
