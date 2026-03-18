# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.2.6...v1.3.0) (2026-03-18)


### Features

* add Telegram notifications and HTTP API ([#54](https://github.com/ottobot-ai/ottochain-watchdog/issues/54)) ([9373ba2](https://github.com/ottobot-ai/ottochain-watchdog/commit/9373ba2379d38ae5d279e3320b608d106ac46a6d))

## [1.2.6](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.2.5...v1.2.6) (2026-03-13)


### Bug Fixes

* **docker:** migrate Dockerfile from npm to pnpm ([#49](https://github.com/ottobot-ai/ottochain-watchdog/issues/49)) ([6c3a093](https://github.com/ottobot-ai/ottochain-watchdog/commit/6c3a093729892baf23b0461346a5116dc11a5f6c))

## [1.2.5](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.2.4...v1.2.5) (2026-03-04)


### Bug Fixes

* restart orchestration — no genesis, managed layers, failure cap ([#39](https://github.com/ottobot-ai/ottochain-watchdog/issues/39)) ([74ed96e](https://github.com/ottobot-ai/ottochain-watchdog/commit/74ed96e2ed162da775a58d7d985e2e0ab27c338e))

## [1.2.4](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.2.3...v1.2.4) (2026-03-03)


### Bug Fixes

* rename container from health-monitor to watchdog ([#37](https://github.com/ottobot-ai/ottochain-watchdog/issues/37)) ([74401e2](https://github.com/ottobot-ai/ottochain-watchdog/commit/74401e2fcf686773db18cfa648879c582aa0b6bc))

## [1.2.3](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.2.2...v1.2.3) (2026-03-03)


### Bug Fixes

* use --input for dispatch payload (gh api -f sends string, not object) ([#34](https://github.com/ottobot-ai/ottochain-watchdog/issues/34)) ([8589c2e](https://github.com/ottobot-ai/ottochain-watchdog/commit/8589c2e56e7148646921d2af5e16383fa37aed09))

## [1.2.2](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.2.1...v1.2.2) (2026-03-02)


### Bug Fixes

* dispatch version-bump from release-please, not tag push ([#32](https://github.com/ottobot-ai/ottochain-watchdog/issues/32)) ([45897b6](https://github.com/ottobot-ai/ottochain-watchdog/commit/45897b6401b26e49d99ba317410d1fae31fa5eb0))

## [1.2.1](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.2.0...v1.2.1) (2026-03-02)


### Bug Fixes

* dispatch component name monitoring → watchdog ([#30](https://github.com/ottobot-ai/ottochain-watchdog/issues/30)) ([4222029](https://github.com/ottobot-ai/ottochain-watchdog/commit/4222029ee22774d10be5be7195523865faf2f909))

## [1.2.0](https://github.com/ottobot-ai/ottochain-watchdog/compare/v1.1.0...v1.2.0) (2026-03-02)


### Features

* services node monitoring + node resource checks ([#28](https://github.com/ottobot-ai/ottochain-watchdog/issues/28)) ([564dc8f](https://github.com/ottobot-ai/ottochain-watchdog/commit/564dc8f7d646d2bedfb5b85ea53abddd08a1b328))


### Bug Fixes

* production container names + accurate health summary ([#27](https://github.com/ottobot-ai/ottochain-watchdog/issues/27)) ([7237178](https://github.com/ottobot-ai/ottochain-watchdog/commit/7237178e3b17860aba503651f50f4ae0c4f02cc3))

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
