/**
 * Tessellation node HTTP API client.
 *
 * Fetches /node/info, /cluster/info, snapshot ordinals from each node.
 */

import type { Layer, NodeInfo, ClusterMember, NodeHealth } from '../types.js';
import type { Config } from '../config.js';
import { log } from '../logger.js';

const FETCH_TIMEOUT = 5_000;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getNodeInfo(ip: string, port: number): Promise<NodeInfo | null> {
  return fetchJson<NodeInfo>(`http://${ip}:${port}/node/info`);
}

export async function getClusterInfo(ip: string, port: number): Promise<ClusterMember[]> {
  return (await fetchJson<ClusterMember[]>(`http://${ip}:${port}/cluster/info`)) ?? [];
}

export async function getLatestOrdinal(ip: string, port: number, layer: Layer): Promise<number> {
  // Different layers have different snapshot endpoints
  const endpoint = layer === 'gl0'
    ? '/global-snapshots/latest'
    : '/snapshots/latest';

  const data = await fetchJson<{ value?: { ordinal?: number }; ordinal?: number }>(
    `http://${ip}:${port}${endpoint}`
  );

  return data?.value?.ordinal ?? data?.ordinal ?? -1;
}

/**
 * Poll full health for one node+layer.
 */
export async function checkNodeHealth(
  ip: string,
  layer: Layer,
  port: number,
): Promise<NodeHealth> {
  const [info, cluster, ordinal] = await Promise.all([
    getNodeInfo(ip, port),
    getClusterInfo(ip, port),
    getLatestOrdinal(ip, port, layer),
  ]);

  return {
    nodeIp: ip,
    layer,
    reachable: info !== null,
    state: info?.state ?? 'Unreachable',
    cluster,
    ordinal,
  };
}

/**
 * Poll health for all nodes on a given layer.
 */
export async function checkLayerHealth(
  config: Config,
  layer: Layer,
): Promise<NodeHealth[]> {
  const port = config.ports[layer];
  return Promise.all(
    config.nodes.map(n => checkNodeHealth(n.ip, layer, port)),
  );
}
