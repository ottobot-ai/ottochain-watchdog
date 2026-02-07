#!/bin/bash
# Health check script for OttoChain Monitoring stack

set -e

PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://localhost:9093}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"

echo "============================================"
echo "  OttoChain Monitoring - Health Check"
echo "============================================"
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_service() {
    local name=$1
    local url=$2
    local endpoint=$3
    
    if curl -sf "$url$endpoint" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $name is healthy"
        return 0
    else
        echo -e "${RED}✗${NC} $name is not responding at $url"
        return 1
    fi
}

# Check core services
echo "Core Services:"
check_service "Prometheus" "$PROMETHEUS_URL" "/-/healthy" || true
check_service "Alertmanager" "$ALERTMANAGER_URL" "/-/healthy" || true
check_service "Grafana" "$GRAFANA_URL" "/api/health" || true

echo ""
echo "Prometheus Targets:"

# Get target status from Prometheus
targets=$(curl -sf "$PROMETHEUS_URL/api/v1/targets" 2>/dev/null)
if [ $? -eq 0 ]; then
    echo "$targets" | jq -r '.data.activeTargets[] | "\(.labels.job): \(.health)"' 2>/dev/null | while read line; do
        job=$(echo "$line" | cut -d: -f1)
        health=$(echo "$line" | cut -d: -f2 | tr -d ' ')
        if [ "$health" = "up" ]; then
            echo -e "  ${GREEN}✓${NC} $job"
        else
            echo -e "  ${RED}✗${NC} $job ($health)"
        fi
    done
else
    echo -e "  ${YELLOW}⚠${NC} Could not fetch targets from Prometheus"
fi

echo ""
echo "Active Alerts:"

# Get alerts from Prometheus
alerts=$(curl -sf "$PROMETHEUS_URL/api/v1/alerts" 2>/dev/null)
if [ $? -eq 0 ]; then
    firing=$(echo "$alerts" | jq -r '[.data.alerts[] | select(.state=="firing")] | length' 2>/dev/null)
    pending=$(echo "$alerts" | jq -r '[.data.alerts[] | select(.state=="pending")] | length' 2>/dev/null)
    
    if [ "$firing" = "0" ] && [ "$pending" = "0" ]; then
        echo -e "  ${GREEN}✓${NC} No active alerts"
    else
        [ "$firing" != "0" ] && echo -e "  ${RED}✗${NC} $firing firing alert(s)"
        [ "$pending" != "0" ] && echo -e "  ${YELLOW}⚠${NC} $pending pending alert(s)"
        
        echo ""
        echo "Firing alerts:"
        echo "$alerts" | jq -r '.data.alerts[] | select(.state=="firing") | "  - \(.labels.alertname) [\(.labels.job)]"' 2>/dev/null
    fi
else
    echo -e "  ${YELLOW}⚠${NC} Could not fetch alerts from Prometheus"
fi

echo ""
