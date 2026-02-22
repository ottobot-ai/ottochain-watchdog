/**
 * Tessellation node HTTP API client.
 *
 * Fetches /node/info, /cluster/info, snapshot ordinals from each node.
 */

import type { LayerName, NodeInfo } from './types.js';
import type { MonitorConfig } from './config.js';

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

interface NodeInfoResponse {
  state: string;
  id?: string;
  host?: string;
  p2pPort?: number;
}

interface ClusterMember {
  id: string;
  ip: string;
  p2pPort: number;
}

export async function getNodeInfo(ip: string, port: number): Promise<NodeInfoResponse | null> {
  return fetchJson<NodeInfoResponse>(`http://${ip}:${port}/node/info`);
}

export async function getClusterInfo(ip: string, port: number): Promise<ClusterMember[]> {
  return (await fetchJson<ClusterMember[]>(`http://${ip}:${port}/cluster/info`)) ?? [];
}

export async function getLatestOrdinal(ip: string, port: number, layer: LayerName): Promise<number> {
  // Different layers have different snapshot endpoints
  const endpoint = layer === 'GL0'
    ? '/global-snapshots/latest'
    : '/snapshots/latest';

  const data = await fetchJson<{ value?: { ordinal?: number }; ordinal?: number }>(
    `http://${ip}:${port}${endpoint}`
  );

  return data?.value?.ordinal ?? data?.ordinal ?? -1;
}

/**
 * Wait for a node to reach Ready state.
 */
export async function waitForReady(
  ip: string,
  port: number,
  timeoutMs = 120_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getNodeInfo(ip, port);
    if (info?.state === 'Ready') return true;
    await new Promise(r => setTimeout(r, 5_000));
  }
  return false;
}
