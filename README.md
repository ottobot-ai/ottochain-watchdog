# OttoChain Monitoring Stack

Centralized monitoring for OttoChain infrastructure using Prometheus, Grafana, and Alertmanager.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ALERTS SERVER                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ Prometheus  │  │ Alertmanager│  │   Grafana   │  │    Loki    │ │
│  │   :9090     │  │    :9093    │  │    :3000    │  │   :3100    │ │
│  └──────┬──────┘  └─────────────┘  └─────────────┘  └────────────┘ │
│         │ scrapes                                                   │
└─────────┼───────────────────────────────────────────────────────────┘
          │
          ├────────────────────────────────────────────┐
          │                                            │
          ▼                                            ▼
┌─────────────────────────────────────┐  ┌──────────────────────────────┐
│         SERVICES SERVER             │  │     METAGRAPH NODES          │
│  ┌─────────┐ ┌─────────┐ ┌───────┐  │  │  GL0 │ ML0 │ CL1 │ DL1      │
│  │ bridge  │ │ indexer │ │gateway│  │  │ :9000│:9200│:9300│:9400     │
│  │ monitor │ │postgres │ │ redis │  │  │  /metrics endpoints         │
│  └─────────┘ └─────────┘ └───────┘  │  │                              │
│  node-exporter:9100                 │  │  node-exporter:9100          │
│  postgres-exporter:9187             │  │                              │
│  redis-exporter:9121                │  │                              │
└─────────────────────────────────────┘  └──────────────────────────────┘
```

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/ottobot-ai/ottochain-monitoring.git
cd ottochain-monitoring

# Copy and edit environment file
cp .env.example .env
nano .env  # Add your Telegram credentials, server IPs, etc.
```

### 2. Generate Prometheus config

```bash
./scripts/generate-config.sh
```

### 3. Deploy monitoring stack (alerts server)

```bash
docker compose up -d
```

### 4. Deploy exporters (on each target server)

On services server:
```bash
cd exporters
docker compose --profile services up -d
```

On metagraph node(s):
```bash
cd exporters
docker compose up -d  # Just node-exporter
```

### 5. Access services

- **Grafana**: http://your-alerts-server:3000 (default: admin/admin)
- **Prometheus**: http://your-alerts-server:9090
- **Alertmanager**: http://your-alerts-server:9093

## Components

### Core Stack

| Service | Port | Description |
|---------|------|-------------|
| Prometheus | 9090 | Metrics collection & alerting engine |
| Alertmanager | 9093 | Alert routing & notification |
| Grafana | 3000 | Visualization & dashboards |
| Loki | 3100 | Log aggregation (optional) |

### Exporters

| Exporter | Port | Description |
|----------|------|-------------|
| node-exporter | 9100 | System metrics (CPU, memory, disk) |
| postgres-exporter | 9187 | PostgreSQL metrics |
| redis-exporter | 9121 | Redis metrics |

### Scraped Endpoints

| Target | Port | Metrics Path |
|--------|------|--------------|
| GL0 (Global L0) | 9000 | /metrics |
| ML0 (Metagraph L0) | 9200 | /metrics |
| CL1 (Currency L1) | 9300 | /metrics |
| DL1 (Data L1) | 9400 | /metrics |
| Monitor Service | 3032 | /metrics |

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for alerts | Yes |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for alerts | Yes |
| `ALERT_SERVER_IP` | IP of the monitoring server | Yes |
| `METAGRAPH_HOST` | IP of the metagraph node(s) | Yes |
| `SERVICES_HOST` | IP of the services server | Yes |
| `GRAFANA_ADMIN_PASSWORD` | Grafana admin password | Yes |
| `POSTGRES_USER` | PostgreSQL username (for exporter) | For services |
| `POSTGRES_PASSWORD` | PostgreSQL password | For services |
| `POSTGRES_DB` | PostgreSQL database name | For services |

### Alert Rules

Alert rules are organized in `prometheus/alert_rules/`:

- **nodes.yml** - Tessellation node health (GL0, ML0, CL1, DL1)
- **services.yml** - OttoChain services (monitor, bridge, etc.)
- **infrastructure.yml** - System resources (CPU, memory, disk)

### Adding Custom Dashboards

1. Create JSON dashboard in `grafana/provisioning/dashboards/`
2. Restart Grafana: `docker compose restart grafana`

## Alert Integrations

### Telegram (Default)

Alerts are sent via Telegram. Configure in `.env`:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=-100123456789
```

### Webhook (OpenClaw Integration)

To receive alerts in OpenClaw, add webhook receiver in `alertmanager/alertmanager.yml`:

```yaml
receivers:
  - name: 'openclaw'
    webhook_configs:
      - url: 'http://OPENCLAW_HOST:PORT/webhook/alertmanager'
        send_resolved: true
```

## API Access

Query Prometheus directly for alert status:

```bash
# Get firing alerts
curl -s http://ALERT_SERVER:9090/api/v1/alerts | jq '.data.alerts[]'

# Get all targets and their health
curl -s http://ALERT_SERVER:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'

# Alertmanager - current alerts
curl -s http://ALERT_SERVER:9093/api/v2/alerts | jq '.'
```

## Maintenance

### Reload Prometheus config (no restart)

```bash
curl -X POST http://localhost:9090/-/reload
```

### Check configuration validity

```bash
docker compose exec prometheus promtool check config /etc/prometheus/prometheus.yml
docker compose exec alertmanager amtool check-config /etc/alertmanager/alertmanager.yml
```

### View logs

```bash
docker compose logs -f prometheus
docker compose logs -f alertmanager
docker compose logs -f grafana
```

### Backup Grafana dashboards

Dashboards are provisioned from files, so they're automatically backed up via git.
For runtime changes, export from Grafana UI and commit to this repo.

## Troubleshooting

### Prometheus can't scrape targets

1. Check target is reachable: `curl http://TARGET:PORT/metrics`
2. Check firewall allows traffic from alerts server
3. Verify prometheus.yml has correct IPs

### Alerts not firing

1. Check rule syntax: `promtool check rules prometheus/alert_rules/*.yml`
2. View Prometheus alerts page: http://localhost:9090/alerts
3. Check Alertmanager received alert: http://localhost:9093/#/alerts

### Telegram notifications not working

1. Verify bot token and chat ID in alertmanager.yml
2. Test manually: `curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=test"`
3. Check alertmanager logs: `docker compose logs alertmanager`

## License

MIT
