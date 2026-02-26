/**
 * Fork Detection Condition
 *
 * Checks each metagraph layer (ML0, CL1, DL1) for cluster forks by comparing
 * the cluster point-of-view from each node. If any node sees a different set
 * of cluster members than the majority, the layer is forked.
 *
 * Pattern from: Constellation metagraph-monitoring-service-package ForkedCluster
 */

import { createHash } from 'crypto';
import type { Config } from '../config.js';
import type { Layer, ClusterMember, DetectionResult } from '../types.js';
import { getClusterInfo } from '../services/node-api.js';
import { log } from '../logger.js';

/** Fetch function type for dependency injection (enables testing) */
export type ClusterFetchFn = (ip: string, port: number) => Promise<ClusterMember[]>;

/** Default fetch using node-api */
export const defaultClusterFetch: ClusterFetchFn = getClusterInfo;

/** POV result from polling a single node */
export interface NodePOV {
  ip: string;
  hash: string;
  members: ClusterMember[];
  error?: string;
}

/**
 * Hash a cluster POV for comparison.
 * Normalize by sorting on peer ID so order doesn't matter.
 */
export function hashClusterPOV(members: ClusterMember[]): string {
  const sorted = [...members]
    .map(m => m.id)
    .sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 12);
}

/**
 * Find majority partition from POV list.
 * Returns majority hash and lists of majority/minority/unreachable nodes.
 */
export function findMajority(povs: NodePOV[]): {
  majorityHash: string;
  majorityNodes: string[];
  minorityNodes: string[];
  unreachable: string[];
} {
  const reachable = povs.filter(p => !p.error);
  const unreachable = povs.filter(p => p.error).map(p => p.ip);

  if (reachable.length === 0) {
    return { majorityHash: '', majorityNodes: [], minorityNodes: [], unreachable };
  }

  // Count frequency of each hash
  const freq: Record<string, number> = {};
  for (const p of reachable) {
    freq[p.hash] = (freq[p.hash] ?? 0) + 1;
  }

  const majorityHash = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])[0][0];

  const majorityNodes = reachable.filter(p => p.hash === majorityHash).map(p => p.ip);
  const minorityNodes = reachable.filter(p => p.hash !== majorityHash).map(p => p.ip);

  return { majorityHash, majorityNodes, minorityNodes, unreachable };
}

/**
 * Check a single layer across all nodes for fork.
 * Returns the IPs of nodes in the minority partition (if any).
 */
export async function checkLayerFork(
  config: Config,
  layer: Layer,
  fetchFn: ClusterFetchFn = defaultClusterFetch,
): Promise<{ forked: boolean; minorityNodes: string[]; unreachable: string[] }> {
  const port = config.ports[layer];

  // Get cluster POV from each node
  const povs: NodePOV[] = [];

  for (const node of config.nodes) {
    try {
      const members = await fetchFn(node.ip, port);
      if (members.length === 0) {
        povs.push({ ip: node.ip, hash: 'empty', members: [] });
      } else {
        povs.push({ ip: node.ip, hash: hashClusterPOV(members), members });
      }
    } catch (err) {
      povs.push({ ip: node.ip, hash: '', members: [], error: String(err) });
    }
  }

  const { majorityHash, minorityNodes, unreachable } = findMajority(povs);

  if (minorityNodes.length > 0) {
    log(`[ForkDetect] ${layer} FORKED — majority=${majorityHash}, minority nodes: ${minorityNodes.join(', ')}`);
    for (const p of povs) {
      log(`[ForkDetect]   ${p.ip}: hash=${p.hash} members=${p.members.length}${p.error ? ` error=${p.error}` : ''}`);
    }
  }

  return { forked: minorityNodes.length > 0, minorityNodes, unreachable };
}

/**
 * Check all metagraph layers for forks.
 */
export async function detectForkedCluster(
  config: Config,
  fetchFn: ClusterFetchFn = defaultClusterFetch,
): Promise<DetectionResult> {
  log('[ForkDetect] Checking cluster POVs across all nodes...');

  for (const layer of ['ml0', 'cl1', 'dl1'] as Layer[]) {
    const result = await checkLayerFork(config, layer, fetchFn);

    if (result.forked) {
      const allForked = result.minorityNodes.length >= config.nodes.length - 1;

      return {
        detected: true,
        condition: 'ForkedCluster',
        details: `${layer.toUpperCase()} forked — minority nodes: ${result.minorityNodes.join(', ')}`,
        restartScope: allForked ? 'full-layer' : 'individual-node',
        affectedNodes: result.minorityNodes,
        affectedLayers: [layer],
      };
    }
  }

  log('[ForkDetect] No forks detected');
  return { detected: false, condition: 'ForkedCluster', details: '', restartScope: 'none' };
}
