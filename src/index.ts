/**
 * OttoChain Watchdog
 *
 * Self-healing watchdog that reads health data from Redis/Postgres (populated
 * by services monitor) and restarts nodes via SSH when needed.
 *
 * Usage:
 *   npx tsx src/index.ts            # Single check
 *   npx tsx src/index.ts --daemon   # Continuous monitoring
 *   npx tsx src/index.ts --once     # Single check (alias)
 *
 * Data Flow:
 *   Services Monitor → Redis → Watchdog (this) → SSH Restart
 *                           ↘ Postgres (events) ↙
 *
 * Alerting is handled by Prometheus/Alertmanager, NOT by the watchdog.
 */

import { loadConfig, type Config } from './config.js';
import { HealthReader } from './services/health-reader.js';
import { detectForkedClusterFromSnapshot } from './conditions/forked-cluster.js';
import { detectSnapshotsStoppedFromSnapshot, StallTracker } from './conditions/snapshots-stopped.js';
import { detectUnhealthyNodesFromSnapshot } from './conditions/unhealthy-nodes.js';
import { detectServicesHealth } from './conditions/services-health.js';
import { detectNodeResourceIssues } from './conditions/node-resources.js';
import { detectHypergraphHealth } from './conditions/hypergraph-health.js';
import { executeRestart, isRestartSuspended, resetRestartState, getRestartState } from './restart/orchestrator.js';
import { EventPublisher } from './services/events.js';
import { NotificationService } from './notifications.js';
import { startApiServer } from './api.js';
import { log } from './logger.js';
import type { DetectionResult, HealthSnapshot } from './types.js';

// Global stall tracker (survives across check cycles)
const stallTracker = new StallTracker();

// Track cycle count for hypergraph check interval multiplier
let cycleCount = 0;

async function runHealthCheck(
  config: Config,
  healthReader: HealthReader,
  eventPublisher: EventPublisher,
  notificationService: NotificationService,
): Promise<void> {
  log('==================== HEALTH CHECK ====================');
  cycleCount++;

  // --- Phase 1: Read health data from Redis (or fallback to direct) ---
  const snapshot = await healthReader.getHealthSnapshot();
  log(`[Monitor] Health data source: ${snapshot.source} (stale: ${snapshot.stale})`);

  // --- Phase 2: Check conditions using the snapshot data ---
  type ConditionEntry = {
    name: string;
    detect: () => DetectionResult | Promise<DetectionResult>;
  };

  const conditions: ConditionEntry[] = [
    { name: 'ForkedCluster', detect: () => detectForkedClusterFromSnapshot(config, snapshot) },
    { name: 'SnapshotsStopped', detect: () => detectSnapshotsStoppedFromSnapshot(config, snapshot, stallTracker) },
    { name: 'UnhealthyNodes', detect: () => detectUnhealthyNodesFromSnapshot(config, snapshot) },
  ];

  // Services node monitoring (if configured)
  if (config.servicesNode) {
    conditions.push({
      name: 'ServicesHealth',
      detect: () => detectServicesHealth(config),
    });
  }

  // Resource monitoring across all nodes (every 3rd cycle to reduce SSH load)
  if (cycleCount === 1 || cycleCount % 3 === 0) {
    conditions.push({
      name: 'NodeResources',
      detect: () => detectNodeResourceIssues(config),
    });
  }

  // Add hypergraph condition if enabled, respecting check interval multiplier
  if (config.hypergraph?.enabled) {
    const multiplier = config.hypergraph.checkIntervalMultiplier;
    if (cycleCount === 1 || cycleCount % multiplier === 0) {
      conditions.push({
        name: 'HypergraphHealth',
        detect: () => detectHypergraphHealth(config, snapshot),
      });
    } else {
      log(`[Monitor] Skipping hypergraph check (cycle ${cycleCount}, runs every ${multiplier})`);
    }
  }

  let issuesDetected = 0;

  for (const condition of conditions) {
    try {
      const result = await condition.detect();

      if (result.detected) {
        issuesDetected++;
        log(`[Monitor] Condition detected: ${condition.name} — ${result.details}`);

        // Notify on detection
        await notificationService.notifyIssueDetected(result);

        if (result.restartScope === 'none') {
          // Detection-only conditions (e.g., hypergraph) — log but don't restart
          log(`[Monitor] ${condition.name}: detection only (restartScope: none), no action taken`);
          await eventPublisher.publishRestart(result, result.restartScope, false);
          continue;
        }

        const restarted = await executeRestart(config, result);

        // Publish restart event to Postgres
        await eventPublisher.publishRestart(result, result.restartScope, restarted);

        // Notify on restart result
        await notificationService.notifyRestartComplete(result, result.restartScope, restarted);

        // Check if we're now suspended
        if (isRestartSuspended()) {
          const state = getRestartState();
          await notificationService.notifyRestartsSuspended(
            state.consecutiveFailures,
            state.lastCondition ?? condition.name,
          );
        }

        if (restarted) {
          log('[Monitor] Restart performed, skipping remaining checks');
          return;
        }
        // If restart was skipped (cooldown/rate limit), continue checking
      }
    } catch (err) {
      log(`[Monitor] Error checking ${condition.name}: ${err}`);
    }
  }

  if (issuesDetected === 0) {
    // If we were in given-up state but health recovered, reset
    if (isRestartSuspended()) {
      resetRestartState();
      log('[Monitor] Health recovered — automatic restarts re-enabled');
      await notificationService.notifyRestartsResumed();
    }
    log('[Monitor] Metagraph is healthy ✓');
  } else {
    log(`[Monitor] Evaluated ${issuesDetected} issue(s) — see above for details`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const healthReader = new HealthReader(config);
  const eventPublisher = new EventPublisher(config);
  const notificationService = new NotificationService({ telegram: config.telegram });

  // Start HTTP API if enabled
  const apiServer = config.api ? startApiServer(config, config.api) : null;

  log('OttoChain Watchdog starting');
  log(`Nodes: ${config.nodes.map(n => `${n.name}(${n.ip})`).join(', ')}`);
  log(`Mode: ${config.daemon ? 'daemon' : 'single check'}`);
  log(`Interval: ${config.healthCheckIntervalSeconds}s`);
  log(`Managed layers: ${config.managedLayers.join(', ')}`);
  log(`Max consecutive failures: ${config.maxConsecutiveFailures}`);
  log(`Health data stale threshold: ${config.healthDataStaleSeconds}s`);
  if (config.hypergraph?.enabled) {
    log(`Hypergraph monitoring: enabled (L0: ${config.hypergraph.l0Urls.join(', ')}, multiplier: ${config.hypergraph.checkIntervalMultiplier}x)`);
  }

  // Publish lifecycle event
  await eventPublisher.publishLifecycle(true);
  await notificationService.notifyLifecycle(true);

  if (config.daemon) {
    // Handle graceful shutdown
    const shutdown = async () => {
      log('[Watchdog] Shutting down...');
      await notificationService.notifyLifecycle(false);
      await eventPublisher.publishLifecycle(false);
      if (apiServer) apiServer.close();
      await healthReader.close();
      await eventPublisher.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await runHealthCheck(config, healthReader, eventPublisher, notificationService);
      } catch (err) {
        log(`[Watchdog] Unexpected error: ${err}`);
      }
      await new Promise(resolve => setTimeout(resolve, config.healthCheckIntervalSeconds * 1000));
    }
  } else {
    await runHealthCheck(config, healthReader, eventPublisher, notificationService);
    if (apiServer) apiServer.close();
    await healthReader.close();
    await eventPublisher.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
