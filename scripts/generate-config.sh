#!/bin/bash
# Generate prometheus.yml and alertmanager.yml from templates
# Uses environment variables from .env file

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if it exists
if [ -f "$PROJECT_DIR/.env" ]; then
    echo "Loading environment from .env..."
    set -a
    source "$PROJECT_DIR/.env"
    set +a
else
    echo "Warning: No .env file found. Using environment variables."
fi

# Required variables
REQUIRED_VARS=(
    "METAGRAPH_HOST"
    "SERVICES_HOST"
)

# Check required variables
missing=0
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        echo "Error: Required variable $var is not set"
        missing=1
    fi
done

if [ $missing -eq 1 ]; then
    echo ""
    echo "Please set the required variables in .env or environment"
    exit 1
fi

# Generate prometheus.yml
echo "Generating prometheus/prometheus.yml..."
envsubst < "$PROJECT_DIR/prometheus/prometheus.yml.template" > "$PROJECT_DIR/prometheus/prometheus.yml"

# Update alertmanager.yml with Telegram credentials if provided
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    echo "Updating alertmanager/alertmanager.yml with Telegram credentials..."
    sed -i "s|bot_token: 'YOUR_TELEGRAM_BOT_TOKEN'|bot_token: '$TELEGRAM_BOT_TOKEN'|g" "$PROJECT_DIR/alertmanager/alertmanager.yml"
    sed -i "s|chat_id: 0|chat_id: $TELEGRAM_CHAT_ID|g" "$PROJECT_DIR/alertmanager/alertmanager.yml"
else
    echo "Warning: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Update alertmanager.yml manually."
fi

echo ""
echo "Configuration generated successfully!"
echo ""
echo "Generated files:"
echo "  - prometheus/prometheus.yml"
echo ""
echo "Next steps:"
echo "  1. Verify prometheus/prometheus.yml targets are correct"
echo "  2. Ensure alertmanager/alertmanager.yml has valid Telegram credentials"
echo "  3. Run: docker compose up -d"
