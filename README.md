# OttoChain Watchdog

Self-healing watchdog for OttoChain metagraph infrastructure. Reads health data from the services monitor (via Redis/Postgres) and restarts nodes via SSH when problems are detected.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SERVICES MONITOR                                      │
│  (packages/monitor in ottochain-services)                               │
│                                                                          │
│  Polls all nodes every 10s                                              │
│  └──→ Caches health in Redis (monitor:health:latest)                    │
│  └──→ Stores events in Postgres (monitoring_events table)               │
│  └──→ Serves status.ottochain.ai                                        │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
                     ┌─────────▼─────────┐
                     │ Redis + Postgres  │
                     └─────────┬─────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────────┐
│                       WATCHDOG (this service)                            │
│                                                                          │
│  1. Read health from Redis/Postgres (PRIMARY)                           │
│     - Falls back to direct HTTP if Redis stale (>60s)                   │
│                                                                          │
│  2. Evaluate conditions:                                                 │
│     - ForkedCluster (cluster POV divergence)                            │
│     - SnapshotsStopped (ML0 ordinal stall)                              │
│     - UnhealthyNodes (unreachable, stuck states)                        │
│                                                                          │
│  3. If restart needed:                                                   │
│     - SSH into nodes                                                     │
│     - Docker stop/start containers                                       │
│     - Rejoin to cluster                                                  │
│                                                                          │
│  4. Write restart events to Postgres                                     │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                    PROMETHEUS + ALERTMANAGER                             │
│  (deployed via ottochain-deploy/monitoring)                              │
│                                                                          │
│  - Scrapes /metrics from all nodes                                       │
│  - Evaluates alert rules                                                 │
│  - Sends notifications to Telegram                                       │
│                                                                          │
│  NOTE: The watchdog does NOT send alerts. Alertmanager owns alerting.    │
└──────────────────────────────────────────────────────────────────────────┘
```

## How It Works

### Data Sources

**Primary: Redis** (populated by services monitor)
- Key: `monitor:health:latest`
- Updated every 10 seconds
- Contains node health, layer states, ordinals, cluster info

**Fallback: Direct HTTP** (used when Redis is stale or unavailable)
- Polls `/node/info` and `/cluster/info` on each node
- Automatically triggered when Redis data is >60s old
- Logs clearly when fallback is active

### Condition Detection

All condition detectors are **pure functions** that operate on health snapshot data:

| Condition | What It Detects | Restart Scope |
|-----------|-----------------|---------------|
| `ForkedCluster` | Nodes disagree on cluster membership | Individual node or full layer |
| `SnapshotsStopped` | ML0 ordinal unchanged for >4 minutes | Full metagraph |
| `UnhealthyNodes` | Unreachable nodes or stuck states | Individual node, layer, or metagraph |

### Restart Strategies

1. **Individual Node** — Kill and rejoin a single node to a healthy reference
2. **Full Layer** — Kill all nodes in a layer, restart with genesis, join validators
3. **Full Metagraph** — Kill all layers in reverse order, restart ML0→CL1/DL1

### Safeguards

- **Cooldown**: 10 minutes between restarts (configurable)
- **Rate Limit**: Max 6 restarts per hour (configurable)
- **Escalation**: Individual restarts escalate to layer/metagraph if no healthy reference exists

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_IPS` | Comma-separated list of node IPs | `10.0.0.1,10.0.0.2,10.0.0.3` |
| `NODE_NAMES` | Comma-separated list of node names | `node1,node2,node3` |
| `SSH_KEY_PATH` | Path to SSH private key | `/root/.ssh/hetzner_ottobot` |
| `SSH_USER` | SSH username | `root` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `DATABASE_URL` | Postgres connection URL | `postgresql://ottochain:...@localhost:5432/ottochain` |
| `HEALTH_DATA_STALE_SECONDS` | Threshold before Redis data is considered stale | `60` |
| `SNAPSHOT_STALL_MINUTES` | Minutes of no ML0 ordinal change before restart | `4` |
| `HEALTH_CHECK_INTERVAL` | Seconds between health checks | `60` |
| `RESTART_COOLDOWN_MINUTES` | Minutes to wait between restarts | `10` |
| `MAX_RESTARTS_PER_HOUR` | Maximum restarts allowed per hour | `6` |

### Layer Ports

| Variable | Layer | Default |
|----------|-------|---------|
| `GL0_PORT` | Global L0 | `9000` |
| `ML0_PORT` | Metagraph L0 | `9200` |
| `CL1_PORT` | Currency L1 | `9300` |
| `DL1_PORT` | Data L1 | `9400` |

## Deployment

The watchdog is deployed via `ottochain-deploy`:

```bash
# In ottochain-deploy repo
docker compose -f compose/watchdog.yml up -d
```

### Docker Image

```
ghcr.io/ottobot-ai/ottochain-watchdog:latest
```

### Required Mounts

- SSH key for node access: `/home/watchdog/.ssh/id_rsa`

## Development

### Prerequisites

- Node.js 20+
- Redis (optional, for testing with real data)
- Postgres (optional, for event publishing)

### Setup

```bash
# Clone the repo
git clone https://github.com/ottobot-ai/ottochain-watchdog.git
cd ottochain-watchdog

# Install dependencies
npm install

# Copy environment file
cp .env.example .env
# Edit .env with your values
```

### Running

```bash
# Development (single check)
npm run dev

# Development (daemon mode)
npm run dev -- --daemon

# Production build
npm run build
npm start -- --daemon
```

### Testing

```bash
# Run tests
npm test

# Watch mode
npm run test:watch
```

## Event Publishing

The watchdog writes events to the `monitoring_events` Postgres table:

| Event Type | When |
|------------|------|
| `WATCHDOG_START` | Service started |
| `WATCHDOG_STOP` | Service stopped (graceful shutdown) |
| `RESTART` | Successful restart completed |
| `RESTART_FAILED` | Restart attempt failed |

These events are displayed on the status page (via services monitor).

## Relationship to Other Components

| Component | Role | Repository |
|-----------|------|------------|
| **Services Monitor** | Polls nodes, caches health, serves status page | `ottochain-services/packages/monitor` |
| **Watchdog** (this) | Reads health, restarts nodes | `ottochain-watchdog` |
| **Prometheus/Alertmanager** | Scrapes metrics, sends alerts | `ottochain-deploy/monitoring` |
| **Deploy Config** | Compose files, monitoring configs | `ottochain-deploy` |

## Troubleshooting

### Watchdog using direct HTTP instead of Redis

1. Check Redis is running: `redis-cli ping`
2. Check services monitor is writing to Redis: `redis-cli GET monitor:health:latest`
3. Check `REDIS_URL` environment variable is correct

### Restarts not happening

1. Check cooldown hasn't been hit: look for "Cooldown active" in logs
2. Check rate limit: look for "Restart loop detected" in logs
3. Verify SSH key is mounted and has correct permissions

### Can't connect to Postgres

Events are optional — the watchdog will continue to function without Postgres, just won't record events. Check `DATABASE_URL` if you need event recording.

## License

MIT
