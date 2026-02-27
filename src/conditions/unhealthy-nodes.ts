/**
 * Unhealthy Node Detection
 *
 * Checks each node per layer for:
 * 1. Not reachable (HTTP timeout)
 * 2. Not in Ready state
 * 3. Stuck in bad state (WaitingForDownload, Leaving, Offline)
 *
 * Pattern from: Constellation UnhealthyNodes condition
 */

import type { Config } from '../config.js';
import type { Layer, DetectionResult, HealthSnapshot, STUCK_STATES } from '../types.js';
import { log } from '../logger.js';

const STUCK_STATE_SET = new Set(['WaitingForDownload', 'Leaving', 'Offline', 'DownloadInProgress', 'Unreachable']);

/**
 * Detect unhealthy nodes from HealthSnapshot data.
 *
 * This is a PURE FUNCTION — no I/O, just data analysis.
 */
export function detectUnhealthyNodesFromSnapshot(
  config: Config,
  snapshot: HealthSnapshot,
): DetectionResult {
  log('[UnhealthyNodes] Checking node health across all layers...');

  const unhealthyByLayer: Record<string, string[]> = {};

  // Check all layers including GL0 (important for split-brain detection)
  for (const layer of ['gl0', 'ml0', 'cl1', 'dl1'] as Layer[]) {
    const unhealthy: string[] = [];

    for (const node of snapshot.nodes) {
      const layerHealth = node.layers.find(l => l.layer === layer);
      
      if (!layerHealth || !layerHealth.reachable || STUCK_STATE_SET.has(layerHealth.state)) {
        unhealthy.push(node.ip);
        const state = layerHealth?.state ?? 'Unreachable';
        const reachable = layerHealth?.reachable ?? false;
        log(`[UnhealthyNodes] ${layer.toUpperCase()} ${node.ip}: state=${state} reachable=${reachable}`);
      }
    }

    if (unhealthy.length > 0) {
      unhealthyByLayer[layer] = unhealthy;
    }
  }

  const affectedLayers = Object.keys(unhealthyByLayer) as Layer[];

  if (affectedLayers.length === 0) {
    log('[UnhealthyNodes] All nodes healthy');
    return { detected: false, condition: 'UnhealthyNodes', details: '', restartScope: 'none' };
  }

  // Determine restart scope
  const allNodesCount = config.nodes.length;

  // If GL0 is fully down, critical — metagraph has no L0 reference
  if (unhealthyByLayer['gl0']?.length === allNodesCount) {
    return {
      detected: true,
      condition: 'UnhealthyNodes',
      details: `GL0 fully down — all ${allNodesCount} nodes unhealthy (metagraph orphaned)`,
      restartScope: 'full-metagraph',
      affectedLayers: ['gl0', 'ml0', 'cl1', 'dl1'],
      affectedNodes: config.nodes.map(n => n.ip),
    };
  }

  // If ML0 is fully down, need full metagraph restart (CL1/DL1 depend on it)
  if (unhealthyByLayer['ml0']?.length === allNodesCount) {
    return {
      detected: true,
      condition: 'UnhealthyNodes',
      details: `ML0 fully down — all ${allNodesCount} nodes unhealthy`,
      restartScope: 'full-metagraph',
      affectedLayers: ['ml0', 'cl1', 'dl1'],
      affectedNodes: config.nodes.map(n => n.ip),
    };
  }

  // If an entire L1 layer is down, restart that layer
  for (const layer of ['cl1', 'dl1'] as Layer[]) {
    if (unhealthyByLayer[layer]?.length === allNodesCount) {
      return {
        detected: true,
        condition: 'UnhealthyNodes',
        details: `${layer.toUpperCase()} fully down — all nodes unhealthy`,
        restartScope: 'full-layer',
        affectedLayers: [layer],
        affectedNodes: config.nodes.map(n => n.ip),
      };
    }
  }

  // Individual unhealthy nodes
  const allUnhealthyIps = [...new Set(Object.values(unhealthyByLayer).flat())];
  const details = affectedLayers
    .map(l => `${l.toUpperCase()}: [${unhealthyByLayer[l].join(', ')}]`)
    .join('; ');

  return {
    detected: true,
    condition: 'UnhealthyNodes',
    details: `Individual unhealthy nodes — ${details}`,
    restartScope: 'individual-node',
    affectedLayers,
    affectedNodes: allUnhealthyIps,
  };
}

// =============================================================================
// Legacy support: Direct polling (used by fallback and tests)
// =============================================================================

import { checkLayerHealth } from '../services/node-api.js';

/**
 * Detect unhealthy nodes via direct HTTP (legacy).
 */
export async function detectUnhealthyNodes(config: Config): Promise<DetectionResult> {
  log('[UnhealthyNodes] Checking node health across all layers...');

  const unhealthyByLayer: Record<string, string[]> = {};

  // Check all layers including GL0 (important for split-brain detection)
  for (const layer of ['gl0', 'ml0', 'cl1', 'dl1'] as Layer[]) {
    const healths = await checkLayerHealth(config, layer);

    const unhealthy = healths.filter(h =>
      !h.reachable || STUCK_STATE_SET.has(h.state) || h.state === 'Unreachable'
    );

    if (unhealthy.length > 0) {
      unhealthyByLayer[layer] = unhealthy.map(h => h.nodeIp);
      for (const h of unhealthy) {
        log(`[UnhealthyNodes] ${layer.toUpperCase()} ${h.nodeIp}: state=${h.state} reachable=${h.reachable}`);
      }
    }
  }

  const affectedLayers = Object.keys(unhealthyByLayer) as Layer[];

  if (affectedLayers.length === 0) {
    log('[UnhealthyNodes] All nodes healthy');
    return { detected: false, condition: 'UnhealthyNodes', details: '', restartScope: 'none' };
  }

  // Determine restart scope
  const allNodesCount = config.nodes.length;

  // If GL0 is fully down, critical — metagraph has no L0 reference
  if (unhealthyByLayer['gl0']?.length === allNodesCount) {
    return {
      detected: true,
      condition: 'UnhealthyNodes',
      details: `GL0 fully down — all ${allNodesCount} nodes unhealthy (metagraph orphaned)`,
      restartScope: 'full-metagraph',
      affectedLayers: ['gl0', 'ml0', 'cl1', 'dl1'],
      affectedNodes: config.nodes.map(n => n.ip),
    };
  }

  // If ML0 is fully down, need full metagraph restart (CL1/DL1 depend on it)
  if (unhealthyByLayer['ml0']?.length === allNodesCount) {
    return {
      detected: true,
      condition: 'UnhealthyNodes',
      details: `ML0 fully down — all ${allNodesCount} nodes unhealthy`,
      restartScope: 'full-metagraph',
      affectedLayers: ['ml0', 'cl1', 'dl1'],
      affectedNodes: config.nodes.map(n => n.ip),
    };
  }

  // If an entire L1 layer is down, restart that layer
  for (const layer of ['cl1', 'dl1'] as Layer[]) {
    if (unhealthyByLayer[layer]?.length === allNodesCount) {
      return {
        detected: true,
        condition: 'UnhealthyNodes',
        details: `${layer.toUpperCase()} fully down — all nodes unhealthy`,
        restartScope: 'full-layer',
        affectedLayers: [layer],
        affectedNodes: config.nodes.map(n => n.ip),
      };
    }
  }

  // Individual unhealthy nodes
  const allUnhealthyIps = [...new Set(Object.values(unhealthyByLayer).flat())];
  const details = affectedLayers
    .map(l => `${l.toUpperCase()}: [${unhealthyByLayer[l].join(', ')}]`)
    .join('; ');

  return {
    detected: true,
    condition: 'UnhealthyNodes',
    details: `Individual unhealthy nodes — ${details}`,
    restartScope: 'individual-node',
    affectedLayers,
    affectedNodes: allUnhealthyIps,
  };
}
