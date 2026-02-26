/**
 * Alert Evaluator
 *
 * Collects resource and Tessellation alerts from all cluster nodes.
 * Publishes alerts to the event system and notifies via webhook.
 */

import type { Config } from '../config.js';
import type { Layer } from '../types.js';
import type { ResourceAlert, NodeResourceSnapshot } from './resource-alerts.js';
import type { TessellationAlert, ML0SnapshotLogEntry, DL1LogEvent } from './tessellation-alerts.js';
import { evaluateResourceAlerts } from './resource-alerts.js';
import {
  checkML0ZeroUpdates,
  checkDL1DownloadOnly,
  checkGL0PeerDrop,
  checkCL1ContainerDown,
} from './tessellation-alerts.js';
import { getNodeInfo, getClusterInfo } from '../services/node-api.js';
import { sshExec } from '../services/ssh.js';
import { log } from '../logger.js';

export interface AlertEvaluationResult {
  resourceAlerts: ResourceAlert[];
  tessellationAlerts: TessellationAlert[];
  hasCritical: boolean;
}

/**
 * Fetch resource metrics from a node via SSH.
 * Returns null if the node is unreachable.
 */
async function fetchNodeResources(
  nodeIp: string,
  config: Config,
): Promise<NodeResourceSnapshot | null> {
  try {
    // Get system metrics via SSH
    const result = await sshExec(nodeIp, `
      echo "RAM_TOTAL=$(grep MemTotal /proc/meminfo | awk '{print $2}')"
      echo "RAM_AVAIL=$(grep MemAvailable /proc/meminfo | awk '{print $2}')"
      echo "SWAP_TOTAL=$(grep SwapTotal /proc/meminfo | awk '{print $2}')"
      echo "SWAP_FREE=$(grep SwapFree /proc/meminfo | awk '{print $2}')"
      echo "DISK_TOTAL=$(df -B1 / | tail -1 | awk '{print $2}')"
      echo "DISK_USED=$(df -B1 / | tail -1 | awk '{print $3}')"
      echo "CPU_PCT=$(top -bn1 | grep 'Cpu(s)' | awk '{print 100 - $8}')"
    `, config);

    if (result.code !== 0) {
      log(`[Alerts] SSH to ${nodeIp} returned code ${result.code}: ${result.stderr}`);
      return null;
    }

    // Parse output
    const vars: Record<string, number> = {};
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match) {
        vars[match[1]] = parseFloat(match[2]) || 0;
      }
    }

    // Convert KB to bytes for RAM/swap
    return {
      nodeIp,
      ramTotal: (vars.RAM_TOTAL || 0) * 1024,
      ramUsed: ((vars.RAM_TOTAL || 0) - (vars.RAM_AVAIL || 0)) * 1024,
      swapTotal: (vars.SWAP_TOTAL || 0) * 1024,
      swapUsed: ((vars.SWAP_TOTAL || 0) - (vars.SWAP_FREE || 0)) * 1024,
      diskTotal: vars.DISK_TOTAL || 0,
      diskUsed: vars.DISK_USED || 0,
      cpuPct: vars.CPU_PCT || 0,
      layerRss: {}, // TODO: Add per-layer RSS if needed
    };
  } catch (err) {
    log(`[Alerts] Failed to fetch resources from ${nodeIp}: ${err}`);
    return null;
  }
}

/**
 * Check GL0 peer count for each node.
 */
async function checkGL0Peers(
  config: Config,
): Promise<TessellationAlert[]> {
  const alerts: TessellationAlert[] = [];

  for (const node of config.nodes) {
    try {
      const cluster = await getClusterInfo(node.ip, config.ports.gl0);
      // Peer count is cluster size minus self
      const peerCount = cluster ? cluster.length - 1 : 0;
      const alert = checkGL0PeerDrop(node.ip, peerCount);
      if (alert) alerts.push(alert);
    } catch {
      // Node unreachable — will be caught by unhealthy-nodes condition
    }
  }

  return alerts;
}

/**
 * Check CL1 container status on each node.
 */
async function checkCL1Containers(
  config: Config,
): Promise<TessellationAlert[]> {
  const alerts: TessellationAlert[] = [];

  for (const node of config.nodes) {
    const nodeIdx = config.nodes.indexOf(node);
    const container = `cl1-${nodeIdx}`;

    try {
      const result = await sshExec(node.ip, `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null || echo "false"`, config);
      const isRunning = result.stdout.trim() === 'true';
      const alert = checkCL1ContainerDown(node.ip, isRunning);
      if (alert) alerts.push(alert);
    } catch {
      // SSH failed — assume container is down
      const alert = checkCL1ContainerDown(node.ip, false);
      if (alert) alerts.push(alert);
    }
  }

  return alerts;
}

/**
 * Evaluate all alerts across the cluster.
 *
 * Note: ML0 zero-updates and DL1 download-only require log parsing
 * which is not yet implemented. These will be added when we have
 * a log aggregation solution (Loki) or structured log streaming.
 */
export async function evaluateAlerts(config: Config): Promise<AlertEvaluationResult> {
  const resourceAlerts: ResourceAlert[] = [];
  const tessellationAlerts: TessellationAlert[] = [];

  // Collect resource alerts from all nodes
  const resourcePromises = config.nodes.map(async (node) => {
    const snapshot = await fetchNodeResources(node.ip, config);
    if (snapshot) {
      const alerts = evaluateResourceAlerts(snapshot);
      resourceAlerts.push(...alerts);
    }
  });

  // Collect Tessellation alerts
  const [gl0Alerts, cl1Alerts] = await Promise.all([
    checkGL0Peers(config),
    checkCL1Containers(config),
    ...resourcePromises,
  ]);

  tessellationAlerts.push(...(gl0Alerts as TessellationAlert[]));
  tessellationAlerts.push(...(cl1Alerts as TessellationAlert[]));

  // Check for critical alerts
  const hasCritical =
    resourceAlerts.some(a => a.severity === 'critical') ||
    tessellationAlerts.some(a => a.severity === 'critical');

  return { resourceAlerts, tessellationAlerts, hasCritical };
}
