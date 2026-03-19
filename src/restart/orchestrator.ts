/**
 * Restart Orchestrator
 *
 * Executes the appropriate restart strategy based on the detection result:
 * - individual-node: kill + restart (run-rollback) + rejoin a single node
 * - full-layer: kill all nodes in layer, restart first node + join others
 * - full-metagraph: kill ML0+L1s, restart ML0 → then L1s
 *
 * IMPORTANT: The watchdog NEVER performs genesis. Genesis is only done by
 * the deploy workflow (GitHub Actions). The watchdog restarts containers
 * using `docker start` which runs the entrypoint in run-rollback mode,
 * allowing nodes to recover from their last known state.
 *
 * Tracks restart history and consecutive failures to prevent restart loops.
 *
 * NOTE: Alerting is handled by Prometheus/Alertmanager. This module only
 * performs restarts and logs events to Postgres.
 */

import type { Config } from '../config.js';
import type { DetectionResult, Layer, RestartEvent } from '../types.js';
import { DEFAULT_MANAGED_LAYERS } from '../types.js';
import { killLayerProcess, dockerControl, sshExec } from '../services/ssh.js';
import { getNodeInfo } from '../services/node-api.js';
import { log } from '../logger.js';
import { sleep } from '../utils/sleep.js';

// In-memory restart history
const restartHistory: RestartEvent[] = [];

// Consecutive failure counter — resets on success
let consecutiveFailures = 0;

// Whether we've given up (hit max failures)
let givenUp = false;

function recentRestartCount(minutes: number): number {
  const cutoff = Date.now() - minutes * 60_000;
  return restartHistory.filter(r => new Date(r.timestamp).getTime() > cutoff).length;
}

/** Container name for a layer on a given node index */
function containerName(layer: Layer, nodeIndex: number): string {
  const useIndexed = process.env.CONTAINER_NAMING === 'indexed';
  return useIndexed ? `${layer}-${nodeIndex}` : layer;
}

/**
 * Check if a layer is managed (watchdog is allowed to restart it).
 */
function isManaged(layer: Layer, config: Config): boolean {
  return config.managedLayers.includes(layer);
}

/**
 * Wait for a node to reach Ready state.
 */
async function waitForReady(
  ip: string,
  port: number,
  timeoutMs = 120_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getNodeInfo(ip, port);
    if (info?.state === 'Ready') return true;
    await sleep(5_000);
  }
  return false;
}

/**
 * Join a node to the cluster via the CLI port.
 */
async function joinCluster(
  nodeIp: string,
  referenceId: string,
  referenceIp: string,
  layer: Layer,
  config: Config,
): Promise<void> {
  const cliPort = config.cliPorts[layer];
  const p2pPort = config.p2pPorts[layer];
  const container = containerName(layer, config.nodes.findIndex(n => n.ip === nodeIp));

  log(`[Restart] Joining ${nodeIp} ${layer} to cluster (reference=${referenceIp})`);
  await sshExec(nodeIp, [
    `docker exec ${container} curl -sf -X POST http://127.0.0.1:${cliPort}/cluster/join`,
    `-H 'Content-Type: application/json'`,
    `-d '{"id":"${referenceId}","ip":"${referenceIp}","p2pPort":${p2pPort}}'`,
  ].join(' '), config);
}

// ============================================================================
// Restart strategies
// ============================================================================

/**
 * Restart individual unhealthy nodes by killing + restarting + rejoining.
 * Uses run-rollback (docker start), NOT genesis.
 */
async function restartIndividualNodes(
  config: Config,
  result: DetectionResult,
): Promise<void> {
  const affectedNodes = result.affectedNodes ?? [];
  const layers = (result.affectedLayers ?? []).filter(l => isManaged(l, config));

  if (layers.length === 0) {
    log(`[Restart] No managed layers in affected set — skipping`);
    return;
  }

  for (const layer of layers) {
    // Find a healthy reference node
    const healthyNode = config.nodes.find(n => !affectedNodes.includes(n.ip));
    if (!healthyNode) {
      log(`[Restart] No healthy reference node for ${layer} — escalating to full-layer`);
      await restartFullLayer(config, layer);
      return;
    }

    const port = config.ports[layer];
    const refInfo = await getNodeInfo(healthyNode.ip, port);
    if (!refInfo) {
      log(`[Restart] Reference node ${healthyNode.ip} unreachable — escalating`);
      await restartFullLayer(config, layer);
      return;
    }

    for (const nodeIp of affectedNodes) {
      const nodeIdx = config.nodes.findIndex(n => n.ip === nodeIp);
      const container = containerName(layer, nodeIdx);

      log(`[Restart] Restarting ${container} on ${nodeIp} (run-rollback)`);
      await killLayerProcess(nodeIp, container, config);
      await sleep(3_000);
      await dockerControl(nodeIp, 'start', container, config);
      await sleep(15_000);

      // Check if it came up on its own (run-rollback may auto-join)
      const info = await getNodeInfo(nodeIp, port);
      if (info?.state === 'Ready') {
        log(`[Restart] ${container} on ${nodeIp} recovered to Ready`);
        continue;
      }

      // Try explicit join
      await joinCluster(nodeIp, refInfo.id, healthyNode.ip, layer, config);
      await waitForReady(nodeIp, port, 90_000);
    }
  }
}

/**
 * Restart an entire layer: kill all → start first node (run-rollback) → join others.
 * Does NOT perform genesis — relies on existing state.
 */
async function restartFullLayer(
  config: Config,
  layer: Layer,
): Promise<void> {
  if (!isManaged(layer, config)) {
    log(`[Restart] ${layer.toUpperCase()} is not a managed layer — skipping`);
    return;
  }

  log(`[Restart] Full ${layer.toUpperCase()} layer restart (run-rollback)`);

  const port = config.ports[layer];

  // Note: ML0 issues are escalated to full-metagraph at the top level of executeRestart().
  // GL0 restarts independently — metagraph layers will reconnect to GL0 peer.

  // Kill all nodes for this layer
  await Promise.all(config.nodes.map((n, i) =>
    killLayerProcess(n.ip, containerName(layer, i), config).catch(() => {})
  ));
  await sleep(5_000);

  // Start first node via run-rollback (docker start)
  const first = config.nodes[0];
  const firstContainer = containerName(layer, 0);
  log(`[Restart] Starting ${firstContainer} on ${first.ip} (run-rollback)`);
  await dockerControl(first.ip, 'start', firstContainer, config);

  if (!await waitForReady(first.ip, port, 180_000)) {
    throw new Error(`${layer} on ${first.ip} did not become Ready after run-rollback`);
  }

  const firstInfo = await getNodeInfo(first.ip, port);
  if (!firstInfo) throw new Error(`Cannot get node info for ${layer} on ${first.ip}`);

  // Start and join remaining nodes
  for (let i = 1; i < config.nodes.length; i++) {
    const node = config.nodes[i];
    const container = containerName(layer, i);
    await dockerControl(node.ip, 'start', container, config);
    await sleep(15_000);

    // Check if auto-joined
    const info = await getNodeInfo(node.ip, port);
    if (info?.state === 'Ready') {
      log(`[Restart] ${container} on ${node.ip} auto-recovered to Ready`);
      continue;
    }

    await joinCluster(node.ip, firstInfo.id, first.ip, layer, config);
  }

  // Wait for all to be Ready
  for (const node of config.nodes) {
    await waitForReady(node.ip, port, 120_000);
  }

  log(`[Restart] ${layer.toUpperCase()} layer restart complete`);
}

/**
 * Full metagraph restart: kill managed layers → start ML0 → start L1s.
 *
 * Uses run-rollback (docker start) — NOT genesis.
 * The first node to start will recover from its last snapshot and
 * other nodes join it.
 */
async function restartFullMetagraph(config: Config): Promise<void> {
  log('[Restart] === Full Metagraph Restart (run-rollback) ===');

  // Only restart managed layers, in reverse dependency order
  const managedReverse = [...config.managedLayers].reverse();

  // Kill managed layers in reverse dependency order
  for (const layer of managedReverse) {
    await Promise.all(config.nodes.map((n, i) =>
      killLayerProcess(n.ip, containerName(layer, i), config).catch(() => {})
    ));
  }
  await sleep(5_000);

  // Start ML0 if managed
  if (config.managedLayers.includes('ml0')) {
    log('[Restart] Starting ML0 (run-rollback)...');
    await dockerControl(config.nodes[0].ip, 'start', containerName('ml0', 0), config);

    if (!await waitForReady(config.nodes[0].ip, config.ports.ml0, 180_000)) {
      throw new Error('ML0 did not become Ready after run-rollback');
    }

    const ml0Info = await getNodeInfo(config.nodes[0].ip, config.ports.ml0);
    if (!ml0Info) throw new Error('Cannot get ML0 info after restart');

    for (let i = 1; i < config.nodes.length; i++) {
      await dockerControl(config.nodes[i].ip, 'start', containerName('ml0', i), config);
      await sleep(15_000);

      const info = await getNodeInfo(config.nodes[i].ip, config.ports.ml0);
      if (info?.state === 'Ready') {
        log(`[Restart] ML0 on ${config.nodes[i].ip} auto-recovered`);
        continue;
      }

      await joinCluster(config.nodes[i].ip, ml0Info.id, config.nodes[0].ip, 'ml0', config);
    }

    // Verify ML0 cluster
    for (const node of config.nodes) {
      await waitForReady(node.ip, config.ports.ml0, 120_000);
    }
    log('[Restart] ML0 cluster ready');
  }

  // Start remaining managed L1 layers
  const l1Layers = config.managedLayers.filter(l => l !== 'ml0' && l !== 'gl0');
  if (l1Layers.length > 0) {
    await Promise.all(l1Layers.map(layer =>
      restartFullLayer(config, layer).catch(err => {
        log(`[Restart] ${layer} restart failed: ${err}`);
      })
    ));
  }

  log('[Restart] === Full Metagraph Restart Complete ===');
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Execute restart based on detection result.
 * Returns true if a restart was performed.
 */
export async function executeRestart(
  config: Config,
  result: DetectionResult,
): Promise<boolean> {
  if (!result.detected || result.restartScope === 'none') return false;

  // If we've given up after max consecutive failures, don't try again
  // until the condition clears (nodes recover on their own or manual intervention)
  if (givenUp) {
    log(`[Restart] Restart suspended after ${config.maxConsecutiveFailures} consecutive failures. Manual intervention required.`);
    return false;
  }

  // Rate limit
  const recentCount = recentRestartCount(60);
  if (recentCount >= config.maxRestartsPerHour) {
    const msg = `Restart loop detected (${recentCount} restarts in 1h). Manual intervention required.`;
    log(`[Restart] ${msg}`);
    return false;
  }

  // Cooldown check
  const lastRestart = restartHistory[restartHistory.length - 1];
  if (lastRestart) {
    const sinceLastMs = Date.now() - new Date(lastRestart.timestamp).getTime();
    if (sinceLastMs < config.restartCooldownMinutes * 60_000) {
      log(`[Restart] Cooldown active (${(sinceLastMs / 60_000).toFixed(1)}m since last restart)`);
      return false;
    }
  }

  // Filter affected layers to only managed ones
  const managedAffected = (result.affectedLayers ?? []).filter(l => isManaged(l, config));
  if (managedAffected.length === 0 && result.restartScope !== 'full-metagraph') {
    log(`[Restart] No managed layers affected (affected: ${result.affectedLayers?.join(', ')}, managed: ${config.managedLayers.join(', ')})`);
    return false;
  }

  // Dependency-aware layer restart logic:
  // - GL0 is independent (can restart alone)
  // - ML0 requires full metagraph restart (ML0 + CL1 + DL1)
  // - CL1/DL1 can restart independently (ML0 stays up)
  const hasML0 = managedAffected.includes('ml0');
  const effectiveScope = hasML0 ? 'full-metagraph' : result.restartScope;
  const effectiveLayers = hasML0
    ? config.managedLayers.filter(l => l !== 'gl0')  // ML0 + L1 layers
    : managedAffected;

  if (hasML0 && result.restartScope !== 'full-metagraph') {
    log(`[Restart] ML0 affected → escalating to full-metagraph restart`);
  }

  log(`[Restart] Initiating ${effectiveScope} restart for ${result.condition}: ${result.details}`);

  const event: RestartEvent = {
    timestamp: new Date().toISOString(),
    scope: effectiveScope,
    condition: result.condition,
    layers: effectiveLayers,
    nodes: result.affectedNodes ?? [],
    success: false,
  };

  try {
    switch (effectiveScope) {
      case 'individual-node':
        await restartIndividualNodes(config, { ...result, affectedLayers: managedAffected });
        break;
      case 'full-layer':
        // Restart layers in dependency order: GL0 first (if affected), then CL1/DL1
        // (ML0 escalates to full-metagraph above, so won't be here)
        if (effectiveLayers.includes('gl0')) {
          await restartFullLayer(config, 'gl0');
        }
        for (const layer of effectiveLayers.filter(l => l !== 'gl0')) {
          await restartFullLayer(config, layer);
        }
        break;
      case 'full-metagraph':
        await restartFullMetagraph(config);
        break;
    }

    event.success = true;
    consecutiveFailures = 0;
    givenUp = false;
    log(`[Restart] Restart complete (${result.restartScope})`);
  } catch (err) {
    event.error = err instanceof Error ? err.message : String(err);
    consecutiveFailures++;
    log(`[Restart] Failed (${consecutiveFailures}/${config.maxConsecutiveFailures}): ${event.error}`);

    if (consecutiveFailures >= config.maxConsecutiveFailures) {
      givenUp = true;
      log(`[Restart] ⛔ Max consecutive failures (${config.maxConsecutiveFailures}) reached. Suspending automatic restarts. Manual intervention required.`);
    }
  }

  restartHistory.push(event);
  return event.success;
}

/**
 * Reset the given-up state (e.g., when a manual restart succeeds or health recovers).
 */
export function resetRestartState(): void {
  consecutiveFailures = 0;
  givenUp = false;
  log('[Restart] Restart state reset — automatic restarts re-enabled');
}

/**
 * Check if automatic restarts are suspended.
 */
export function isRestartSuspended(): boolean {
  return givenUp;
}

/**
 * Get consecutive failure count.
 */
export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

/**
 * Get restart state summary (for API/notifications).
 */
export function getRestartState(): {
  consecutiveFailures: number;
  suspended: boolean;
  lastRestartTime: Date | null;
  lastCondition: string | null;
} {
  const lastRestart = restartHistory.length > 0 ? restartHistory[restartHistory.length - 1] : null;
  return {
    consecutiveFailures,
    suspended: givenUp,
    lastRestartTime: lastRestart ? new Date(lastRestart.timestamp) : null,
    lastCondition: lastRestart?.condition ?? null,
  };
}

/**
 * Get recent restart history (for status page / debugging).
 */
export function getRestartHistory(): RestartEvent[] {
  return [...restartHistory];
}
