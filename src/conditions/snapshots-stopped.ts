/**
 * Snapshot Stall Detection
 *
 * Tracks ML0 snapshot ordinals over time. If the ordinal hasn't advanced
 * for longer than the configured threshold, triggers a full metagraph restart.
 *
 * Pattern from: Constellation SnapshotsStopped condition
 */

import type { Config } from '../config.js';
import type { DetectionResult, HealthSnapshot } from '../types.js';
import { log } from '../logger.js';

/** Fetch function type for dependency injection (used by legacy direct mode) */
export type OrdinalFetchFn = (ip: string, port: number) => Promise<number>;

/** Snapshot state for a node+layer combo */
export interface OrdinalState {
  ordinal: number;
  timestamp: number;
}

/**
 * Stall tracker class for testability.
 * Tracks ordinals and calculates stale time.
 */
export class StallTracker {
  private state = new Map<string, OrdinalState>();

  private key(nodeId: string, layer: string): string {
    return `${nodeId}:${layer}`;
  }

  /** Update ordinal for a node+layer. Returns true if ordinal advanced. */
  update(nodeId: string, layer: string, ordinal: number, timestamp = Date.now()): boolean {
    const k = this.key(nodeId, layer);
    const prev = this.state.get(k);

    if (!prev || ordinal !== prev.ordinal) {
      this.state.set(k, { ordinal, timestamp });
      return !prev || ordinal > prev.ordinal;
    }

    return false;
  }

  /** Get seconds since last ordinal change. Returns null if never tracked. */
  staleSecs(nodeId: string, layer: string, now = Date.now()): number | null {
    const s = this.state.get(this.key(nodeId, layer));
    if (!s) return null;
    return (now - s.timestamp) / 1000;
  }

  /** Get last known ordinal for a node+layer. */
  lastOrdinal(nodeId: string, layer: string): number | undefined {
    return this.state.get(this.key(nodeId, layer))?.ordinal;
  }

  /** Clear all state. */
  reset(): void {
    this.state.clear();
  }
}

// Global tracker instance (survives across check cycles)
const globalTracker = new StallTracker();

/**
 * Detect snapshot stall from HealthSnapshot data.
 *
 * This is a PURE FUNCTION — no I/O, just data analysis with tracker state.
 */
export function detectSnapshotsStoppedFromSnapshot(
  config: Config,
  snapshot: HealthSnapshot,
  tracker: StallTracker = globalTracker,
): DetectionResult {
  log('[SnapshotStall] Checking ML0 snapshot progress...');

  // Find first reachable ML0 node
  let currentOrdinal = -1;
  let reachableNode: string | null = null;

  for (const node of snapshot.nodes) {
    const ml0 = node.layers.find(l => l.layer === 'ml0' && l.reachable);
    if (ml0 && ml0.ordinal >= 0) {
      currentOrdinal = ml0.ordinal;
      reachableNode = node.ip;
      break;
    }
  }

  if (currentOrdinal < 0 || !reachableNode) {
    // Can't reach any ML0 — this is an unhealthy-nodes problem, not a stall
    log('[SnapshotStall] Cannot reach any ML0 node');
    return { detected: false, condition: 'SnapshotsStopped', details: 'ML0 unreachable', restartScope: 'none' };
  }

  const prevOrdinal = tracker.lastOrdinal(reachableNode, 'ml0');
  const advanced = tracker.update(reachableNode, 'ml0', currentOrdinal);

  if (advanced || prevOrdinal === undefined) {
    // Ordinal advanced — healthy
    log(`[SnapshotStall] ML0 ordinal ${prevOrdinal ?? 'N/A'} → ${currentOrdinal} (healthy)`);
    return { detected: false, condition: 'SnapshotsStopped', details: '', restartScope: 'none' };
  }

  // Ordinal unchanged — how long?
  const staleSecs = tracker.staleSecs(reachableNode, 'ml0') ?? 0;
  const staleMinutes = staleSecs / 60;
  const thresholdMinutes = config.snapshotStallMinutes ?? 4;

  if (staleMinutes >= thresholdMinutes) {
    const msg = `ML0 snapshots stalled at ordinal ${currentOrdinal} for ${staleMinutes.toFixed(1)} minutes`;
    log(`[SnapshotStall] ${msg}`);
    return {
      detected: true,
      condition: 'SnapshotsStopped',
      details: msg,
      restartScope: 'full-metagraph',
      affectedLayers: ['ml0', 'cl1', 'dl1'],
      affectedNodes: config.nodes.map(n => n.ip),
    };
  }

  log(`[SnapshotStall] ML0 ordinal=${currentOrdinal} unchanged for ${staleMinutes.toFixed(1)}m (threshold: ${thresholdMinutes}m)`);
  return { detected: false, condition: 'SnapshotsStopped', details: '', restartScope: 'none' };
}

// =============================================================================
// Legacy support: Direct polling (used by fallback and tests)
// =============================================================================

import { getLatestOrdinal } from '../services/node-api.js';

/** Default fetch using node-api */
export const defaultOrdinalFetch: OrdinalFetchFn = async (ip, port) =>
  getLatestOrdinal(ip, port, 'ml0');

/**
 * Check if ML0 snapshots have stalled via direct HTTP.
 *
 * We check the ML0 ordinal from the first reachable node.
 * If it hasn't changed since the last check, track elapsed time.
 */
export async function detectSnapshotsStopped(
  config: Config,
  fetchFn: OrdinalFetchFn = defaultOrdinalFetch,
  tracker: StallTracker = globalTracker,
): Promise<DetectionResult> {
  log('[SnapshotStall] Checking ML0 snapshot progress...');

  let currentOrdinal = -1;
  let reachableNode: string | null = null;

  // Try all nodes until we get an ordinal
  for (const node of config.nodes) {
    try {
      const ordinal = await fetchFn(node.ip, config.ports.ml0);
      if (ordinal >= 0) {
        currentOrdinal = ordinal;
        reachableNode = node.ip;
        break;
      }
    } catch {
      // Try next node
    }
  }

  if (currentOrdinal < 0 || !reachableNode) {
    // Can't reach any ML0 — this is an unhealthy-nodes problem, not a stall
    log('[SnapshotStall] Cannot reach any ML0 node');
    return { detected: false, condition: 'SnapshotsStopped', details: 'ML0 unreachable', restartScope: 'none' };
  }

  const prevOrdinal = tracker.lastOrdinal(reachableNode, 'ml0');
  const advanced = tracker.update(reachableNode, 'ml0', currentOrdinal);

  if (advanced || prevOrdinal === undefined) {
    // Ordinal advanced — healthy
    log(`[SnapshotStall] ML0 ordinal ${prevOrdinal ?? 'N/A'} → ${currentOrdinal} (healthy)`);
    return { detected: false, condition: 'SnapshotsStopped', details: '', restartScope: 'none' };
  }

  // Ordinal unchanged — how long?
  const staleSecs = tracker.staleSecs(reachableNode, 'ml0') ?? 0;
  const staleMinutes = staleSecs / 60;
  const thresholdMinutes = config.snapshotStallMinutes ?? 4;

  if (staleMinutes >= thresholdMinutes) {
    const msg = `ML0 snapshots stalled at ordinal ${currentOrdinal} for ${staleMinutes.toFixed(1)} minutes`;
    log(`[SnapshotStall] ${msg}`);
    return {
      detected: true,
      condition: 'SnapshotsStopped',
      details: msg,
      restartScope: 'full-metagraph',
      affectedLayers: ['ml0', 'cl1', 'dl1'],
      affectedNodes: config.nodes.map(n => n.ip),
    };
  }

  log(`[SnapshotStall] ML0 ordinal=${currentOrdinal} unchanged for ${staleMinutes.toFixed(1)}m (threshold: ${thresholdMinutes}m)`);
  return { detected: false, condition: 'SnapshotsStopped', details: '', restartScope: 'none' };
}
