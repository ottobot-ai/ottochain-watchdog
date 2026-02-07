#!/bin/bash
# First-time setup script for OttoChain Monitoring

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "============================================"
echo "  OttoChain Monitoring - Setup"
echo "============================================"
echo ""

# Check for Docker
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed"
    echo "Please install Docker first: https://docs.docker.com/engine/install/"
    exit 1
fi

# Check for Docker Compose
if ! docker compose version &> /dev/null; then
    echo "Error: Docker Compose is not available"
    echo "Please install Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi

echo "✓ Docker and Docker Compose are installed"
echo ""

# Create .env if it doesn't exist
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "Creating .env from .env.example..."
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    echo ""
    echo "⚠️  Please edit .env with your configuration:"
    echo "   nano $PROJECT_DIR/.env"
    echo ""
    echo "Required settings:"
    echo "  - TELEGRAM_BOT_TOKEN (for alerts)"
    echo "  - TELEGRAM_CHAT_ID (for alerts)"
    echo "  - METAGRAPH_HOST (IP of metagraph node)"
    echo "  - SERVICES_HOST (IP of services server)"
    echo "  - GRAFANA_ADMIN_PASSWORD"
    echo ""
    exit 0
else
    echo "✓ .env file exists"
fi

# Generate Prometheus config
echo ""
echo "Generating configuration files..."
"$SCRIPT_DIR/generate-config.sh"

# Validate configurations
echo ""
echo "Validating configurations..."

# Check prometheus.yml exists
if [ ! -f "$PROJECT_DIR/prometheus/prometheus.yml" ]; then
    echo "Error: prometheus/prometheus.yml was not generated"
    exit 1
fi
echo "✓ prometheus/prometheus.yml"

# Check alertmanager.yml
if [ -f "$PROJECT_DIR/alertmanager/alertmanager.yml" ]; then
    echo "✓ alertmanager/alertmanager.yml"
else
    echo "Error: alertmanager/alertmanager.yml not found"
    exit 1
fi

# Check Grafana dashboards
dashboard_count=$(find "$PROJECT_DIR/grafana/provisioning/dashboards" -name "*.json" | wc -l)
echo "✓ $dashboard_count Grafana dashboard(s) found"

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "To start the monitoring stack:"
echo "  cd $PROJECT_DIR"
echo "  docker compose up -d"
echo ""
echo "To start exporters on target servers:"
echo "  # On services server:"
echo "  docker compose -f docker-compose.exporters.yml --profile services up -d"
echo ""
echo "  # On metagraph nodes:"
echo "  docker compose -f docker-compose.exporters.yml up -d"
echo ""
echo "Access:"
echo "  - Grafana:      http://localhost:3000"
echo "  - Prometheus:   http://localhost:9090"
echo "  - Alertmanager: http://localhost:9093"
