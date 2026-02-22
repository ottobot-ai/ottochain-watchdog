/**
 * Main monitoring loop.
 *
 * Polls all layers, detects conditions, and orchestrates recovery.
 * Designed to run as a PM2-managed process.
 */

import type { LayerName, HealthEvent, OrdinalSnapshot } from './types.js';
import type { MonitorConfig } from './config.js';
import { pollLayerCluster, detectForks, detectGL0Fork } from './cluster.js';
import { fetchML0Ordinal, fetchGL0Ordinal, StallTracker, detectStalls, detectClusterStall } from './snapshot.js';
import { executeRestartPlan } from './restart.js';
import { notify } from './notify.js';

// ── Cooldown tracker — prevent restart storms ──────────────────────────────────

const lastActionTime = new Map<string, number>();
const ACTION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes per condition key

function canAct(key: string): boolean {
  const last = lastActionTime.get(key);
  if (!last) return true;
  return Date.now() - last > ACTION_COOLDOWN_MS;
}

function recordAction(key: string): void {
  lastActionTime.set(key, Date.now());
}

// ── Deduplication — don't notify the same event twice in a row ─────────────────

const lastNotified = new Map<string, string>();

function eventKey(event: HealthEvent): string {
  return `${event.condition}:${event.layer}:${event.nodeIds.sort().join(',')}`;
}

function shouldNotify(event: HealthEvent): boolean {
  const key = eventKey(event);
  const last = lastNotified.get(key);
  if (!last) { lastNotified.set(key, event.timestamp); return true; }

  // Re-notify if it's been > 15 minutes since last notification
  const prev = new Date(last).getTime();
  const now  = new Date(event.timestamp).getTime();
  if (now - prev > 15 * 60 * 1000) {
    lastNotified.set(key, event.timestamp);
    return true;
  }
  return false;
}

// ── Main monitor class ─────────────────────────────────────────────────────────

const LAYERS: LayerName[] = ['GL0', 'ML0', 'CL1', 'DL1'];

export class MetagraphMonitor {
  private stallTracker = new StallTracker();
  private running      = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: MonitorConfig) {}

  async start(): Promise<void> {
    console.log('[monitor] Starting metagraph health monitor');
    console.log(`[monitor] Poll interval: ${this.config.pollIntervalMs}ms`);
    console.log(`[monitor] Stall threshold: ${this.config.snapshotStallThresholdSec}s`);
    console.log(`[monitor] Dry run: ${this.config.dryRun}`);
    console.log(`[monitor] Nodes: ${this.config.nodes.map(n => `node${n.nodeId}(${n.host})`).join(', ')}`);

    this.running = true;
    await this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    console.log('[monitor] Stopped');
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), this.config.pollIntervalMs);
  }

  async tick(): Promise<void> {
    const ts = new Date().toISOString();
    console.log(`\n[monitor] ── Poll at ${ts} ──`);

    const events: HealthEvent[] = [];

    // ── 1. Cluster fork detection (all layers) ──────────────────────────────
    for (const layer of LAYERS) {
      try {
        const snapshot = await pollLayerCluster(this.config.nodes, layer);
        const forkEvents = detectForks(snapshot);
        events.push(...forkEvents);
      } catch (err) {
        console.error(`[monitor] Error polling ${layer} cluster: ${err}`);
      }
    }

    // ── 2. GL0 ordinal fork detection ───────────────────────────────────────
    try {
      const gl0Snaps = await Promise.all(
        this.config.nodes.map((n) => fetchGL0Ordinal(n))
      );
      const gl0States = gl0Snaps
        .filter((s): s is OrdinalSnapshot => s !== null)
        .map((s) => ({ nodeId: s.nodeId, ordinal: s.ordinal }));

      const forkEvent = detectGL0Fork(gl0States, ts);
      if (forkEvent) events.push(forkEvent);

      // Also update stall tracker
      for (const snap of gl0Snaps) {
        if (snap) this.stallTracker.update(snap);
      }
    } catch (err) {
      console.error(`[monitor] Error fetching GL0 ordinals: ${err}`);
    }

    // ── 3. ML0 snapshot stall detection ─────────────────────────────────────
    try {
      const ml0Snaps = await Promise.all(
        this.config.nodes.map((n) => fetchML0Ordinal(n))
      );
      const validSnaps = ml0Snaps.filter((s): s is OrdinalSnapshot => s !== null);

      const stallEvents = detectStalls(validSnaps, this.stallTracker, this.config.snapshotStallThresholdSec);
      events.push(...stallEvents);

      const clusterStall = detectClusterStall(
        'ML0', this.config.nodes, this.stallTracker, this.config.snapshotStallThresholdSec
      );
      if (clusterStall) events.push(clusterStall);
    } catch (err) {
      console.error(`[monitor] Error checking ML0 stall: ${err}`);
    }

    // ── 4. Log and handle events ─────────────────────────────────────────────
    if (events.length === 0) {
      console.log('[monitor] ✓ All healthy');
    } else {
      for (const event of events) {
        if (shouldNotify(event)) {
          await notify(event, this.config);
        }
        await this.handleEvent(event);
      }
    }

    this.scheduleNext();
  }

  private async handleEvent(event: HealthEvent): Promise<void> {
    if (!event.suggestedAction) return;

    const key = eventKey(event);
    if (!canAct(key)) {
      console.log(`[monitor] Cooldown active for ${key}, skipping action`);
      return;
    }

    // Wait the configured delay before acting (gives time for transient issues to resolve)
    console.log(`[monitor] Will act in ${this.config.actionDelayMs}ms: ${event.suggestedAction} on ${event.layer}`);
    await new Promise((r) => setTimeout(r, this.config.actionDelayMs));

    // Re-poll to confirm the condition persists before restarting
    if (event.condition === 'SNAPSHOT_STALL' || event.condition === 'FORK_DETECTED') {
      try {
        const recheck = await pollLayerCluster(this.config.nodes, event.layer);
        const recheckForks = detectForks(recheck);
        if (recheckForks.length === 0 && event.condition === 'FORK_DETECTED') {
          console.log(`[monitor] Condition resolved on recheck — skipping restart`);
          return;
        }
      } catch {
        // Continue with restart if recheck fails
      }
    }

    recordAction(key);

    const affectedNodeIds = event.nodeIds;
    const affectedNodes   = this.config.nodes.filter((n) => affectedNodeIds.includes(n.nodeId));
    const seedNode        = this.config.nodes.find((n) => !affectedNodeIds.includes(n.nodeId));

    await executeRestartPlan(
      {
        scope:        event.suggestedAction!,
        layer:        event.layer,
        targetNodeId: affectedNodeIds[0],
        seedNodeId:   seedNode?.nodeId,
        reason:       event.description,
      },
      this.config.nodes,
      this.config
    );

    console.log(`[monitor] ✓ Recovery action complete for ${event.condition} on ${event.layer}`);
  }
}
