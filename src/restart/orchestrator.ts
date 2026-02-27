/**
 * Restart Orchestrator
 *
 * Executes the appropriate restart strategy based on the detection result:
 * - individual-node: kill + rejoin a single node to a healthy reference
 * - full-layer: kill all nodes in layer, restart with genesis + join
 * - full-metagraph: kill everything, pick rollback node, restart ML0→L1s
 *
 * Tracks restart history to prevent restart loops.
 *
 * NOTE: Alerting is handled by Prometheus/Alertmanager. This module only
 * performs restarts and logs events to Postgres.
 */

import type { Config } from '../config.js';
import type { DetectionResult, Layer, RestartEvent } from '../types.js';
import { killLayerProcess, dockerControl, sshExec } from '../services/ssh.js';
import { getNodeInfo } from '../services/node-api.js';
import { log } from '../logger.js';

// In-memory restart history
const restartHistory: RestartEvent[] = [];

function recentRestartCount(minutes: number): number {
  const cutoff = Date.now() - minutes * 60_000;
  return restartHistory.filter(r => new Date(r.timestamp).getTime() > cutoff).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Container name for a layer on a given node index */
function containerName(layer: Layer, nodeIndex: number): string {
  // Our Docker naming convention: gl0-0, ml0-0, dl1-0, etc.
  return `${layer}-${nodeIndex}`;
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
  genesisId: string,
  genesisIp: string,
  layer: Layer,
  config: Config,
): Promise<void> {
  const cliPort = config.cliPorts[layer];
  const p2pPort = config.p2pPorts[layer];
  const container = containerName(layer, config.nodes.findIndex(n => n.ip === nodeIp));

  log(`[Restart] Joining ${nodeIp} ${layer} to cluster (genesis=${genesisIp})`);
  await sshExec(nodeIp, [
    `docker exec ${container} curl -sf -X POST http://127.0.0.1:${cliPort}/cluster/join`,
    `-H 'Content-Type: application/json'`,
    `-d '{"id":"${genesisId}","ip":"${genesisIp}","p2pPort":${p2pPort}}'`,
  ].join(' '), config);
}

// ============================================================================
// Restart strategies
// ============================================================================

/**
 * Restart individual unhealthy nodes by killing + rejoining.
 */
async function restartIndividualNodes(
  config: Config,
  result: DetectionResult,
): Promise<void> {
  const affectedNodes = result.affectedNodes ?? [];
  const layers = result.affectedLayers ?? [];

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

      log(`[Restart] Restarting ${container} on ${nodeIp}`);
      await killLayerProcess(nodeIp, container, config);
      await sleep(3_000);
      await dockerControl(nodeIp, 'start', container, config);
      await sleep(10_000);
      await joinCluster(nodeIp, refInfo.id, healthyNode.ip, layer, config);
      await waitForReady(nodeIp, port, 90_000);
    }
  }
}

/**
 * Restart an entire layer: kill all → start genesis → join validators.
 */
async function restartFullLayer(
  config: Config,
  layer: Layer,
): Promise<void> {
  log(`[Restart] Full ${layer.toUpperCase()} layer restart`);

  const port = config.ports[layer];

  // If ML0 is down, need full metagraph restart (L1s depend on ML0)
  if (layer === 'ml0') {
    log('[Restart] ML0 down → escalating to full metagraph restart');
    await restartFullMetagraph(config);
    return;
  }

  // Kill all nodes for this layer
  await Promise.all(config.nodes.map((n, i) =>
    killLayerProcess(n.ip, containerName(layer, i), config)
  ));
  await sleep(5_000);

  // Start genesis node (index 0)
  const genesis = config.nodes[0];
  const genesisContainer = containerName(layer, 0);
  await dockerControl(genesis.ip, 'start', genesisContainer, config);

  if (!await waitForReady(genesis.ip, port)) {
    throw new Error(`${layer} genesis on ${genesis.ip} did not become Ready`);
  }

  const genesisInfo = await getNodeInfo(genesis.ip, port);
  if (!genesisInfo) throw new Error(`Cannot get genesis info for ${layer}`);

  // Start and join validators
  for (let i = 1; i < config.nodes.length; i++) {
    const node = config.nodes[i];
    const container = containerName(layer, i);
    await dockerControl(node.ip, 'start', container, config);
    await sleep(10_000);
    await joinCluster(node.ip, genesisInfo.id, genesis.ip, layer, config);
  }

  // Wait for all to be Ready
  for (const node of config.nodes) {
    await waitForReady(node.ip, port, 120_000);
  }

  log(`[Restart] ${layer.toUpperCase()} layer restart complete`);
}

/**
 * Full metagraph restart: kill everything → start ML0 → start L1s.
 *
 * Picks the "rollback node" — the node most likely to have the latest state.
 * For now, uses node 0 (genesis). A future improvement could check which node
 * has the highest ordinal.
 */
async function restartFullMetagraph(config: Config): Promise<void> {
  log('[Restart] === Full Metagraph Restart ===');

  const layers: Layer[] = ['dl1', 'cl1', 'ml0'];

  // Kill all layers in reverse dependency order
  for (const layer of layers) {
    await Promise.all(config.nodes.map((n, i) =>
      killLayerProcess(n.ip, containerName(layer, i), config).catch(() => {})
    ));
  }
  await sleep(5_000);

  // Start ML0 (genesis first, then validators)
  log('[Restart] Starting ML0...');
  await dockerControl(config.nodes[0].ip, 'start', containerName('ml0', 0), config);
  if (!await waitForReady(config.nodes[0].ip, config.ports.ml0)) {
    throw new Error('ML0 genesis did not become Ready');
  }

  const ml0Info = await getNodeInfo(config.nodes[0].ip, config.ports.ml0);
  if (!ml0Info) throw new Error('Cannot get ML0 genesis info');

  for (let i = 1; i < config.nodes.length; i++) {
    await dockerControl(config.nodes[i].ip, 'start', containerName('ml0', i), config);
    await sleep(10_000);
    await joinCluster(config.nodes[i].ip, ml0Info.id, config.nodes[0].ip, 'ml0', config);
  }

  // Wait for ML0 cluster
  for (const node of config.nodes) {
    await waitForReady(node.ip, config.ports.ml0, 120_000);
  }
  log('[Restart] ML0 cluster ready');

  // Start CL1 and DL1 in parallel
  const l1Layers: Layer[] = ['cl1', 'dl1'];
  await Promise.all(l1Layers.map(layer => restartFullLayer(config, layer).catch(err => {
    log(`[Restart] ${layer} restart failed: ${err}`);
  })));

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

  // Rate limit
  const recentCount = recentRestartCount(60);
  if (recentCount >= config.maxRestartsPerHour) {
    const msg = `Restart loop detected (${recentCount} restarts in 1h). Manual intervention required.`;
    log(`[Restart] ${msg}`);
    // NOTE: Alertmanager handles alerting via Prometheus metrics
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

  log(`[Restart] Initiating ${result.restartScope} restart for ${result.condition}: ${result.details}`);

  const event: RestartEvent = {
    timestamp: new Date().toISOString(),
    scope: result.restartScope,
    condition: result.condition,
    layers: result.affectedLayers ?? [],
    nodes: result.affectedNodes ?? [],
    success: false,
  };

  try {
    switch (result.restartScope) {
      case 'individual-node':
        await restartIndividualNodes(config, result);
        break;
      case 'full-layer':
        for (const layer of result.affectedLayers ?? []) {
          await restartFullLayer(config, layer);
        }
        break;
      case 'full-metagraph':
        await restartFullMetagraph(config);
        break;
    }

    event.success = true;
    log(`[Restart] Restart complete (${result.restartScope})`);
  } catch (err) {
    event.error = err instanceof Error ? err.message : String(err);
    log(`[Restart] Failed: ${event.error}`);
  }

  restartHistory.push(event);
  return event.success;
}

/**
 * Get recent restart history (for status page / debugging).
 */
export function getRestartHistory(): RestartEvent[] {
  return [...restartHistory];
}
