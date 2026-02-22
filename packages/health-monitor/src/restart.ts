/**
 * Restart Orchestration
 *
 * Three restart scopes:
 *   IndividualNode — restart one node's layer process, rejoin to healthy seed
 *   FullLayer      — stop all nodes, restart with genesis/join sequence
 *   FullMetagraph  — stop everything, restart ML0 first, then CL1/DL1
 *
 * Includes rate limiting to prevent restart storms.
 */

import type { NodeInfo, LayerName, RestartPlan } from './types.js';
import type { MonitorConfig } from './config.js';
import { restartLayerOnNode, stopLayerOnNode } from './ssh.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

interface RestartEvent {
  timestamp: string;
  scope: 'individual' | 'layer' | 'metagraph';
  layer?: LayerName;
  nodeId?: string;
}

const restartHistory: RestartEvent[] = [];
const MAX_RESTARTS_PER_HOUR = 6;
const HISTORY_RETENTION_MS = 60 * 60 * 1000; // 1 hour

function recordRestart(event: Omit<RestartEvent, 'timestamp'>): void {
  restartHistory.push({ ...event, timestamp: new Date().toISOString() });
  // Prune old entries
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  while (restartHistory.length > 0 && new Date(restartHistory[0].timestamp).getTime() < cutoff) {
    restartHistory.shift();
  }
}

function recentRestartCount(): number {
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  return restartHistory.filter(r => new Date(r.timestamp).getTime() > cutoff).length;
}

function canRestart(): { allowed: boolean; reason?: string } {
  const count = recentRestartCount();
  if (count >= MAX_RESTARTS_PER_HOUR) {
    return { 
      allowed: false, 
      reason: `Rate limit exceeded: ${count}/${MAX_RESTARTS_PER_HOUR} restarts in the last hour` 
    };
  }
  return { allowed: true };
}

// ── Individual node restart ───────────────────────────────────────────────────

export async function restartIndividualNode(
  targetNode: NodeInfo,
  layer:      LayerName,
  seedNode:   NodeInfo | undefined,
  config:     MonitorConfig
): Promise<void> {
  const check = canRestart();
  if (!check.allowed) {
    console.log(`[restart] Skipping individual restart: ${check.reason}`);
    return;
  }

  console.log(`[restart] IndividualNode: ${layer} node${targetNode.nodeId} → seed=${seedNode?.nodeId ?? 'none'}`);
  recordRestart({ scope: 'individual', layer, nodeId: targetNode.nodeId });
  
  await restartLayerOnNode(targetNode, layer, config, seedNode?.host);
  await sleep(15_000);
}

// ── Full layer restart ────────────────────────────────────────────────────────

export async function restartFullLayer(
  nodes:  NodeInfo[],
  layer:  LayerName,
  config: MonitorConfig
): Promise<void> {
  const check = canRestart();
  if (!check.allowed) {
    console.log(`[restart] Skipping layer restart: ${check.reason}`);
    return;
  }

  console.log(`[restart] FullLayer: ${layer} — stopping all ${nodes.length} nodes`);
  recordRestart({ scope: 'layer', layer });

  await Promise.all(nodes.map(n => stopLayerOnNode(n, layer, config)));
  await sleep(5_000);

  const [genesis, ...validators] = nodes;
  console.log(`[restart] Starting genesis: node${genesis.nodeId}`);
  await restartLayerOnNode(genesis, layer, config);
  await sleep(20_000);

  for (const validator of validators) {
    console.log(`[restart] Joining validator: node${validator.nodeId} → genesis=${genesis.host}`);
    await restartLayerOnNode(validator, layer, config, genesis.host);
    await sleep(5_000);
  }
}

// ── Full metagraph restart ────────────────────────────────────────────────────

export async function restartFullMetagraph(
  nodes:  NodeInfo[],
  config: MonitorConfig
): Promise<void> {
  const check = canRestart();
  if (!check.allowed) {
    console.log(`[restart] Skipping metagraph restart: ${check.reason}`);
    return;
  }

  console.log(`[restart] FullMetagraph: restarting entire stack`);
  recordRestart({ scope: 'metagraph' });

  const l1Layers: LayerName[] = ['CL1', 'DL1'];
  for (const layer of l1Layers) {
    await Promise.all(nodes.map(n => stopLayerOnNode(n, layer, config)));
  }
  await sleep(2_000);

  await Promise.all(nodes.map(n => stopLayerOnNode(n, 'ML0', config)));
  await sleep(5_000);

  await restartFullLayer(nodes, 'ML0', config);
  await sleep(30_000);

  await Promise.all(l1Layers.map(layer => restartFullLayer(nodes, layer, config)));
}

// ── Plan executor ─────────────────────────────────────────────────────────────

export async function executeRestartPlan(
  plan:   RestartPlan,
  nodes:  NodeInfo[],
  config: MonitorConfig
): Promise<void> {
  console.log(`[restart] Executing plan: ${plan.scope} for ${plan.layer ?? 'metagraph'}`);

  switch (plan.scope) {
    case 'IndividualNode': {
      const target = nodes.find(n => n.nodeId === plan.targetNodeId);
      const seed   = nodes.find(n => n.nodeId === plan.seedNodeId);
      if (!target || !plan.layer) {
        console.error('[restart] Invalid individual node plan');
        return;
      }
      await restartIndividualNode(target, plan.layer, seed, config);
      break;
    }

    case 'FullLayer': {
      if (!plan.layer) {
        console.error('[restart] FullLayer plan missing layer');
        return;
      }
      await restartFullLayer(nodes, plan.layer, config);
      break;
    }

    case 'FullMetagraph': {
      await restartFullMetagraph(nodes, config);
      break;
    }
  }
}

export function getRestartStats() {
  return {
    count: recentRestartCount(),
    limit: MAX_RESTARTS_PER_HOUR,
    history: [...restartHistory],
  };
}
