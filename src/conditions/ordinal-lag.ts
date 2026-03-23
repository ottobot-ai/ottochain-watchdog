/**
 * Ordinal Lag Detection
 *
 * Detects nodes that have fallen behind their peers on the same layer.
 * A node is "lagging" if:
 *   1. It's reachable and in Ready state
 *   2. Its ordinal is significantly behind the max ordinal of its peers
 *   3. It has been lagging for longer than the configured threshold
 *
 * This catches the scenario where a node is in the cluster but stuck
 * (e.g., gossip timeouts) — it responds to health checks but isn't
 * participating in consensus. UnhealthyNodes won't catch this because
 * the node appears healthy.
 *
 * Applies to GL0, ML0, and DL1 layers.
 */

import type { Config } from '../config.js';
import type { DetectionResult, HealthSnapshot, Layer } from '../types.js';
import { log } from '../logger.js';

/** How far behind (in ordinals) a node must be to be considered lagging */
const DEFAULT_LAG_THRESHOLD = 50;

/** How long (seconds) a node must be lagging before triggering restart */
const DEFAULT_LAG_DURATION_SECS = 300; // 5 minutes

/** Track when we first noticed a node lagging */
interface LagState {
  firstSeen: number;
  ordinal: number;
  peerMax: number;
  individualRestartAttempted: boolean;
}

const lagTracker = new Map<string, LagState>();

/** Reset all tracking state (for testing) */
export function resetLagTracker(): void {
  lagTracker.clear();
}

function lagKey(nodeIp: string, layer: string): string {
  return `${nodeIp}:${layer}`;
}

/**
 * Detect nodes with ordinal lag from HealthSnapshot data.
 */
export function detectOrdinalLagFromSnapshot(
  config: Config,
  snapshot: HealthSnapshot,
): DetectionResult {
  log('[OrdinalLag] Checking per-node ordinal sync across layers...');

  const lagThreshold = (config as any).ordinalLagThreshold ?? DEFAULT_LAG_THRESHOLD;
  const lagDurationSecs = (config as any).ordinalLagDurationSecs ?? DEFAULT_LAG_DURATION_SECS;
  const now = Date.now();

  const laggingNodes: { ip: string; layer: Layer; ordinal: number; peerMax: number; lagSecs: number }[] = [];

  for (const layer of ['gl0', 'ml0', 'dl1'] as Layer[]) {
    // Collect ordinals for all reachable Ready nodes on this layer
    const nodeOrdinals: { ip: string; ordinal: number }[] = [];

    for (const node of snapshot.nodes) {
      const layerHealth = node.layers.find(l => l.layer === layer);
      if (layerHealth && layerHealth.reachable && layerHealth.state === 'Ready' && layerHealth.ordinal >= 0) {
        nodeOrdinals.push({ ip: node.ip, ordinal: layerHealth.ordinal });
      }
    }

    // Need at least 2 nodes to compare
    if (nodeOrdinals.length < 2) continue;

    const maxOrdinal = Math.max(...nodeOrdinals.map(n => n.ordinal));

    for (const node of nodeOrdinals) {
      const lag = maxOrdinal - node.ordinal;
      const key = lagKey(node.ip, layer);

      if (lag >= lagThreshold) {
        // Node is lagging — track it
        const existing = lagTracker.get(key);
        if (!existing) {
          lagTracker.set(key, { firstSeen: now, ordinal: node.ordinal, peerMax: maxOrdinal, individualRestartAttempted: false });
          log(`[OrdinalLag] ${layer.toUpperCase()} ${node.ip}: ordinal ${node.ordinal} is ${lag} behind peers (max: ${maxOrdinal}) — tracking`);
        } else {
          const lagSecs = (now - existing.firstSeen) / 1000;
          if (lagSecs >= lagDurationSecs) {
            laggingNodes.push({ ip: node.ip, layer, ordinal: node.ordinal, peerMax: maxOrdinal, lagSecs });
            log(`[OrdinalLag] ${layer.toUpperCase()} ${node.ip}: ordinal ${node.ordinal} behind ${maxOrdinal} for ${lagSecs.toFixed(0)}s — RESTART`);
          } else {
            log(`[OrdinalLag] ${layer.toUpperCase()} ${node.ip}: lagging for ${lagSecs.toFixed(0)}s (threshold: ${lagDurationSecs}s)`);
          }
        }
      } else {
        // Node is caught up — clear tracking
        if (lagTracker.has(key)) {
          log(`[OrdinalLag] ${layer.toUpperCase()} ${node.ip}: caught up (ordinal ${node.ordinal})`);
          lagTracker.delete(key);
        }
      }
    }
  }

  if (laggingNodes.length === 0) {
    return { detected: false, condition: 'OrdinalLag', details: '', restartScope: 'none' };
  }

  const details = laggingNodes
    .map(n => `${n.layer.toUpperCase()} ${n.ip}: ordinal ${n.ordinal} (peers at ${n.peerMax}, lagging ${n.lagSecs.toFixed(0)}s)`)
    .join('; ');

  const affectedLayers = [...new Set(laggingNodes.map(n => n.layer))];
  const affectedNodes = [...new Set(laggingNodes.map(n => n.ip))];

  // Determine restart scope with progressive escalation:
  //
  // For each affected layer, check:
  //   1. How many nodes are lagging vs total reachable?
  //   2. Has an individual restart already been attempted?
  //
  // Strategy:
  //   - Single node lagging + majority aligned → try individual restart first
  //   - Individual restart already tried (still lagging) → escalate to full-layer
  //   - Multiple nodes lagging (no clear majority) → full-layer immediately
  //
  // This applies to ALL layers including GL0/ML0. We proved individual
  // restart works when the majority is healthy — but if it doesn't fix
  // the problem, we escalate immediately on the next detection cycle.

  let restartScope: 'individual-node' | 'full-layer' = 'individual-node';

  for (const layer of affectedLayers) {
    // Count reachable Ready nodes on this layer
    let totalReady = 0;
    for (const node of snapshot.nodes) {
      const lh = node.layers.find(l => l.layer === layer);
      if (lh && lh.reachable && lh.state === 'Ready') totalReady++;
    }

    const laggingOnLayer = laggingNodes.filter(n => n.layer === layer);
    const laggingCount = laggingOnLayer.length;
    const majorityHealthy = laggingCount < totalReady / 2;

    if (!majorityHealthy) {
      // No clear majority — cluster is broken, full-layer restart
      log(`[OrdinalLag] ${layer.toUpperCase()}: ${laggingCount}/${totalReady} nodes lagging — no majority, full-layer restart`);
      restartScope = 'full-layer';
      break;
    }

    // Check if we already tried individual restart for any of these nodes
    const anyPreviouslyAttempted = laggingOnLayer.some(n => {
      const state = lagTracker.get(lagKey(n.ip, n.layer));
      return state?.individualRestartAttempted === true;
    });

    if (anyPreviouslyAttempted) {
      // Individual restart didn't fix it — escalate
      log(`[OrdinalLag] ${layer.toUpperCase()}: individual restart already attempted — escalating to full-layer`);
      restartScope = 'full-layer';
      break;
    }

    // Majority healthy + first attempt → try individual restart
    log(`[OrdinalLag] ${layer.toUpperCase()}: ${laggingCount}/${totalReady} lagging, majority aligned — trying individual restart`);
  }

  // Mark nodes as having had individual restart attempted (for escalation next cycle)
  // Clear tracker for full-layer (fresh start after layer restart)
  if (restartScope === 'individual-node') {
    for (const n of laggingNodes) {
      const key = lagKey(n.ip, n.layer);
      const state = lagTracker.get(key);
      if (state) {
        state.individualRestartAttempted = true;
      }
    }
  } else {
    // Full-layer restart — clear all tracking for affected layers
    for (const n of laggingNodes) {
      lagTracker.delete(lagKey(n.ip, n.layer));
    }
  }

  return {
    detected: true,
    condition: 'OrdinalLag',
    details: `${details} [scope: ${restartScope}]`,
    restartScope,
    affectedNodes,
    affectedLayers,
  };
}
