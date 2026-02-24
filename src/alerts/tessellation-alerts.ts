/**
 * Tessellation Alert Rules
 *
 * Monitors Tessellation-specific log patterns and cluster state to detect
 * silent pipeline failures before they cause downtime.
 *
 * Spec: docs/stability-alert-rules-restart-sop.md
 * Card: 📜 Stability: Tessellation log analysis for error patterns (69962fd9fd)
 *
 * ## 4 Alert Rules (from spec):
 *
 * 1. ML0 Zero-Updates — DL1 pipeline broken
 *    Pattern: "Got 0 updates" in ML0 logs >3 consecutive snapshots
 *    Action: Page James + check DL1 immediately
 *
 * 2. DL1 Download-Only — DL1 not producing blocks
 *    Pattern: "DownloadPerformed" with no "RoundFinished" in 15-min window
 *    Action: Page James + check DL1 peer count
 *
 * 3. GL0 Peer Count Drop — split-brain detection
 *    Pattern: GL0 API returns peerCount == 0 for > 2 minutes
 *    Action: Page James immediately (current P0 scenario)
 *
 * 4. CL1 Container Down
 *    Pattern: docker container not running for > 5 minutes
 *    Action: Notify James — CL1 down = no consensus layer
 */

import type { Severity } from './resource-alerts.js';

/** A Tessellation-specific alert */
export interface TessellationAlert {
  nodeIp: string;
  ruleId: AlertRuleId;
  severity: Severity;
  message: string;
  /** Contextual data for the alert */
  details: Record<string, unknown>;
}

/** Well-known alert rule identifiers */
export type AlertRuleId =
  | 'ml0-zero-updates'
  | 'dl1-download-only'
  | 'gl0-peer-drop'
  | 'cl1-container-down';

/** ML0 snapshot log entry */
export interface ML0SnapshotLogEntry {
  timestamp: Date;
  updateCount: number;
}

/** DL1 log event types relevant to block production */
export type DL1EventType = 'DownloadPerformed' | 'RoundFinished' | 'BlockProduced' | 'Other';

/** A parsed DL1 log event */
export interface DL1LogEvent {
  timestamp: Date;
  eventType: DL1EventType;
}

/**
 * Evaluate ML0 snapshot logs for zero-update pattern.
 *
 * Fires 'critical' alert when >= threshold consecutive snapshots return 0 updates.
 * Does NOT fire on sporadic 0-update snapshots during low traffic.
 *
 * @param nodeIp - IP of the ML0 node
 * @param entries - Recent ML0 snapshot log entries (in chronological order)
 * @param threshold - Consecutive zero-update count to trigger alert (default: 3)
 * @returns Alert if threshold crossed, null otherwise
 */
export function checkML0ZeroUpdates(
  nodeIp: string,
  entries: ML0SnapshotLogEntry[],
  threshold: number = 3,
): TessellationAlert | null {
  if (entries.length === 0) return null;

  // Find maximum consecutive run of zero-update snapshots
  let maxConsecutive = 0;
  let current = 0;

  for (const entry of entries) {
    if (entry.updateCount === 0) {
      current++;
      if (current > maxConsecutive) maxConsecutive = current;
    } else {
      current = 0;
    }
  }

  if (maxConsecutive < threshold) return null;

  return {
    nodeIp,
    ruleId: 'ml0-zero-updates',
    severity: 'critical',
    message: `${nodeIp}: ML0 received 0 updates for ${maxConsecutive} consecutive snapshots — DL1 pipeline broken`,
    details: {
      consecutiveZeroUpdates: maxConsecutive,
      threshold,
    },
  };
}

/**
 * Evaluate DL1 log events for download-only pattern (not producing blocks).
 *
 * Fires 'critical' alert when >= downloadThreshold consecutive DownloadPerformed events
 * occur without any RoundFinished in that run.
 *
 * @param nodeIp - IP of the DL1 node
 * @param events - DL1 log events in a recent time window (chronological)
 * @param downloadThreshold - Consecutive DownloadPerformed to trigger (default: 5)
 * @returns Alert if threshold crossed, null otherwise
 */
export function checkDL1DownloadOnly(
  nodeIp: string,
  events: DL1LogEvent[],
  downloadThreshold: number = 5,
): TessellationAlert | null {
  if (events.length === 0) return null;

  // Find maximum consecutive run of DownloadPerformed events
  // RoundFinished and BlockProduced events reset the counter
  let maxConsecutive = 0;
  let current = 0;

  for (const event of events) {
    if (event.eventType === 'DownloadPerformed') {
      current++;
      if (current > maxConsecutive) maxConsecutive = current;
    } else if (event.eventType === 'RoundFinished' || event.eventType === 'BlockProduced') {
      current = 0;
    }
    // 'Other' events do not reset the counter
  }

  if (maxConsecutive < downloadThreshold) return null;

  return {
    nodeIp,
    ruleId: 'dl1-download-only',
    severity: 'critical',
    message: `${nodeIp}: DL1 in download-only / follower mode — ${maxConsecutive} consecutive downloads, no peer block production. Check DL1 peer count and GL0 cluster state.`,
    details: {
      consecutiveDownloads: maxConsecutive,
      threshold: downloadThreshold,
    },
  };
}

/**
 * Evaluate GL0 peer count for split-brain / isolation.
 *
 * Fires 'critical' alert immediately when peerCount == 0 on any node.
 * peerCount == 1 is valid (2-node majority cluster).
 *
 * @param nodeIp - IP of the GL0 node
 * @param peerCount - Number of GL0 peers from /cluster/info
 * @returns Alert if isolated (peerCount == 0), null otherwise
 */
export function checkGL0PeerDrop(
  nodeIp: string,
  peerCount: number,
): TessellationAlert | null {
  if (peerCount > 0) return null;

  return {
    nodeIp,
    ruleId: 'gl0-peer-drop',
    severity: 'critical',
    message: `${nodeIp}: GL0 is isolated — peer count is 0, node is running a solo chain (split-brain). Immediate restart with seedlist required.`,
    details: {
      peerCount,
    },
  };
}

/**
 * Evaluate CL1 container status.
 *
 * Fires 'warning' alert when CL1 container is not running.
 *
 * @param nodeIp - IP of the node
 * @param isRunning - Whether the CL1 container is currently running
 * @returns Alert if not running, null otherwise
 */
export function checkCL1ContainerDown(
  nodeIp: string,
  isRunning: boolean,
): TessellationAlert | null {
  if (isRunning) return null;

  return {
    nodeIp,
    ruleId: 'cl1-container-down',
    severity: 'warning',
    message: `${nodeIp}: CL1 consensus layer container is not running — no currency consensus on this node`,
    details: {
      isRunning: false,
    },
  };
}

/**
 * Check whether a log line matches the benign EmberServer error pattern.
 * Lines matching this should be IGNORED by the alert pipeline.
 *
 * These are triggered by external HTTP probes sending malformed payloads —
 * 5–10 per day per node, non-actionable.
 *
 * @returns true if the line is a benign Ember probe error
 */
export function isBenignEmberError(logLine: string): boolean {
  return logLine.includes('EmberServerBuilderCompanionPlatform');
}
