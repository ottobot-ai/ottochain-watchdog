#!/bin/bash
# OttoChain Cluster Recovery Script
# Handles forked clusters, session mismatches, and cascade failures
# 
# Usage: ./recover-cluster.sh [--dry-run] [--layer gl0|ml0|cl1|dl1] [--wipe-all]
#
# This script:
# 1. Detects forked clusters by comparing session IDs
# 2. Identifies the majority cluster
# 3. Stops and wipes minority nodes
# 4. Restarts them in join mode
# 5. Triggers manual joins

set -euo pipefail

# Configuration - override via environment
SSH_KEY="${SSH_KEY:-~/.ssh/hetzner_ottobot}"
NODES="${NODES:-5.78.90.207 5.78.113.25 5.78.107.77}"
DRY_RUN="${DRY_RUN:-false}"
WIPE_ALL="${WIPE_ALL:-false}"
TARGET_LAYER="${TARGET_LAYER:-all}"

# Layer port mappings
declare -A PORTS=(
  [gl0]=9000
  [ml0]=9200
  [cl1]=9300
  [dl1]=9400
)

declare -A CLI_PORTS=(
  [gl0]=9002
  [ml0]=9202
  [cl1]=9302
  [dl1]=9402
)

declare -A P2P_PORTS=(
  [gl0]=9001
  [ml0]=9201
  [cl1]=9301
  [dl1]=9401
)

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --wipe-all) WIPE_ALL=true; shift ;;
    --layer) TARGET_LAYER="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log() { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "[$(date '+%H:%M:%S')] ⚠️  $*" >&2; }
error() { echo "[$(date '+%H:%M:%S')] ❌ $*" >&2; }

ssh_cmd() {
  local ip="$1"
  shift
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "root@$ip" "$@" 2>/dev/null
}

get_node_info() {
  local ip="$1"
  local port="$2"
  curl -s --connect-timeout 3 "http://$ip:$port/node/info" 2>/dev/null || echo "{}"
}

get_cluster_info() {
  local ip="$1"
  local port="$2"
  curl -s --connect-timeout 3 "http://$ip:$port/cluster/info" 2>/dev/null || echo "[]"
}

# Analyze cluster state for a layer
analyze_layer() {
  local layer="$1"
  local port="${PORTS[$layer]}"
  
  log "Analyzing $layer (port $port)..."
  
  declare -A sessions
  declare -A states
  declare -A sizes
  declare -A ids
  
  for ip in $NODES; do
    local info=$(get_node_info "$ip" "$port")
    local cluster=$(get_cluster_info "$ip" "$port")
    
    states[$ip]=$(echo "$info" | jq -r '.state // "unreachable"')
    sessions[$ip]=$(echo "$info" | jq -r '.clusterSession // "null"')
    sizes[$ip]=$(echo "$cluster" | jq 'length')
    ids[$ip]=$(echo "$info" | jq -r '.id // "unknown"')
    
    echo "  $ip: state=${states[$ip]} session=${sessions[$ip]} cluster_size=${sizes[$ip]}"
  done
  
  # Count sessions to find majority
  declare -A session_counts
  local majority_session=""
  local majority_count=0
  
  for ip in $NODES; do
    local sess="${sessions[$ip]}"
    if [[ "$sess" != "null" && "$sess" != "" ]]; then
      session_counts[$sess]=$((${session_counts[$sess]:-0} + 1))
      if [[ ${session_counts[$sess]} -gt $majority_count ]]; then
        majority_count=${session_counts[$sess]}
        majority_session="$sess"
      fi
    fi
  done
  
  # Identify minority nodes
  local minority_nodes=""
  local majority_nodes=""
  local genesis_node=""
  
  for ip in $NODES; do
    if [[ "${sessions[$ip]}" == "$majority_session" ]]; then
      majority_nodes="$majority_nodes $ip"
      # First majority node is our join target
      [[ -z "$genesis_node" ]] && genesis_node="$ip"
    elif [[ "${states[$ip]}" != "unreachable" ]]; then
      minority_nodes="$minority_nodes $ip"
    fi
  done
  
  echo ""
  if [[ -n "$minority_nodes" ]]; then
    warn "$layer FORKED - majority session: $majority_session (count: $majority_count)"
    warn "Minority nodes:$minority_nodes"
    warn "Majority nodes:$majority_nodes"
    echo "FORK:$layer:$genesis_node:$minority_nodes"
  else
    log "$layer healthy - all nodes in session $majority_session"
    echo "OK:$layer"
  fi
}

# Recover a forked layer
recover_layer() {
  local layer="$1"
  local genesis_ip="$2"
  shift 2
  local minority_nodes="$@"
  
  local port="${PORTS[$layer]}"
  local cli_port="${CLI_PORTS[$layer]}"
  local p2p_port="${P2P_PORTS[$layer]}"
  local data_dir="/opt/ottochain/${layer}-data"
  
  log "Recovering $layer - genesis: $genesis_ip, minority: $minority_nodes"
  
  # Get genesis node's peer ID
  local genesis_id=$(get_node_info "$genesis_ip" "$port" | jq -r '.id')
  log "Genesis node ID: ${genesis_id:0:16}..."
  
  for ip in $minority_nodes; do
    log "Recovering node $ip..."
    
    if [[ "$DRY_RUN" == "true" ]]; then
      log "[DRY-RUN] Would stop $layer, wipe $data_dir, restart, and join to $genesis_ip"
      continue
    fi
    
    # Stop container
    log "  Stopping $layer..."
    ssh_cmd "$ip" "docker stop $layer" || true
    
    # Wipe data
    log "  Wiping $data_dir..."
    ssh_cmd "$ip" "rm -rf $data_dir/*"
    
    # Ensure IS_INITIAL=false
    log "  Setting IS_INITIAL=false..."
    ssh_cmd "$ip" "cd /opt/ottochain && sed -i 's/IS_INITIAL=.*/IS_INITIAL=false/' .env"
    
    # Start container
    log "  Starting $layer..."
    ssh_cmd "$ip" "cd /opt/ottochain && docker compose up -d $layer"
    
    # Wait for ReadyToJoin
    log "  Waiting for ReadyToJoin state..."
    for i in {1..30}; do
      local state=$(get_node_info "$ip" "$port" | jq -r '.state // "unknown"')
      if [[ "$state" == "ReadyToJoin" ]]; then
        log "  Node ready to join after ${i}s"
        break
      fi
      sleep 1
    done
    
    # Trigger join via CLI port (from inside the node)
    log "  Triggering join to $genesis_ip..."
    ssh_cmd "$ip" "curl -s -X POST 'http://localhost:$cli_port/cluster/join' \
      -H 'Content-Type: application/json' \
      -d '{\"id\":\"$genesis_id\",\"ip\":\"$genesis_ip\",\"p2pPort\":$p2p_port}'" || true
    
    # Wait for join
    sleep 5
    local final_state=$(get_node_info "$ip" "$port" | jq -r '.state // "unknown"')
    local cluster_size=$(get_cluster_info "$ip" "$port" | jq 'length')
    
    if [[ "$final_state" == "Ready" || "$final_state" == "Observing" ]]; then
      log "  ✅ Node recovered: state=$final_state cluster_size=$cluster_size"
    else
      warn "  Node may need attention: state=$final_state cluster_size=$cluster_size"
    fi
  done
}

# Main
log "OttoChain Cluster Recovery"
log "Nodes: $NODES"
log "Dry run: $DRY_RUN"
echo ""

if [[ "$WIPE_ALL" == "true" ]]; then
  warn "WIPE_ALL requested - this will destroy all cluster state!"
  warn "Use the release-scratch.yml GitHub workflow instead for full redeploy."
  exit 1
fi

# Analyze all layers (or just target)
declare -a forks=()

if [[ "$TARGET_LAYER" == "all" ]]; then
  layers="gl0 ml0 cl1 dl1"
else
  layers="$TARGET_LAYER"
fi

for layer in $layers; do
  result=$(analyze_layer "$layer" | tail -1)
  if [[ "$result" == FORK:* ]]; then
    forks+=("$result")
  fi
  echo ""
done

# Report and optionally recover
if [[ ${#forks[@]} -eq 0 ]]; then
  log "✅ No forks detected"
  exit 0
fi

log "Found ${#forks[@]} forked layer(s)"

for fork in "${forks[@]}"; do
  IFS=: read -r _ layer genesis_ip minority_nodes <<< "$fork"
  minority_count=$(echo "$minority_nodes" | wc -w)
  
  if [[ "$minority_count" -gt 1 ]]; then
    warn "SEVERE FORK: $minority_count nodes in minority for $layer"
    warn "Manual recovery unlikely to succeed due to tessellation session handling."
    warn "Recommend: gh workflow run release-scratch.yml --repo ottobot-ai/ottochain-deploy -f wipe_state=true"
    continue
  fi
  
  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] Would recover $layer: genesis=$genesis_ip minority=$minority_nodes"
  else
    read -p "Recover $layer (1 minority node)? [y/N] " confirm
    if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
      recover_layer "$layer" "$genesis_ip" $minority_nodes
    fi
  fi
done

log "Recovery complete"
