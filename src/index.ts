/**
 * OttoChain Health Monitor
 *
 * Centralized metagraph monitoring service that detects forks, stalled
 * snapshots, and unhealthy nodes — then orchestrates recovery via SSH.
 *
 * Usage:
 *   npx tsx src/index.ts            # Single check
 *   npx tsx src/index.ts --daemon   # Continuous monitoring
 *   npx tsx src/index.ts --once     # Single check (alias)
 *
 * Modeled after Constellation's metagraph-monitoring-service-package
 * but purpose-built for OttoChain's Hetzner/Docker infrastructure.
 */

import { loadConfig, type Config } from './config.js';
import { detectForkedCluster } from './conditions/forked-cluster.js';
import { detectSnapshotsStopped } from './conditions/snapshots-stopped.js';
import { detectUnhealthyNodes } from './conditions/unhealthy-nodes.js';
import { evaluateAlerts } from './alerts/evaluator.js';
import { executeRestart } from './restart/orchestrator.js';
import { EventPublisher } from './services/events.js';
import { notify } from './services/notify.js';
import { log } from './logger.js';

async function runHealthCheck(
  config: Config,
  eventPublisher: EventPublisher,
): Promise<void> {
  log('==================== HEALTH CHECK ====================');

  // --- Phase 1: Check critical conditions (may trigger restart) ---
  const conditions = [
    { name: 'ForkedCluster', detect: () => detectForkedCluster(config) },
    { name: 'SnapshotsStopped', detect: () => detectSnapshotsStopped(config) },
    { name: 'UnhealthyNodes', detect: () => detectUnhealthyNodes(config) },
  ];

  for (const condition of conditions) {
    try {
      const result = await condition.detect();

      if (result.detected) {
        log(`[Monitor] Condition detected: ${condition.name} — ${result.details}`);

        // Publish alert event
        await eventPublisher.publishAlert(
          result.condition,
          'CRITICAL',
          result.details,
          result.affectedNodes,
          result.affectedLayers,
        );

        const restarted = await executeRestart(config, result);

        // Publish restart event
        await eventPublisher.publishRestart(result, result.restartScope, restarted);

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

  // --- Phase 2: Evaluate resource and Tessellation alerts ---
  try {
    const alertResult = await evaluateAlerts(config);
    const totalAlerts = alertResult.resourceAlerts.length + alertResult.tessellationAlerts.length;

    if (totalAlerts > 0) {
      log(`[Monitor] Evaluated ${totalAlerts} alert(s) (critical: ${alertResult.hasCritical})`);

      // Log resource alerts
      for (const alert of alertResult.resourceAlerts) {
        log(`[Alert] ${alert.severity.toUpperCase()}: ${alert.message}`);
        await eventPublisher.publishAlert(
          alert.metric,
          alert.severity === 'critical' ? 'CRITICAL' : 'WARNING',
          alert.message,
          [alert.nodeIp],
        );
      }

      // Log Tessellation alerts
      for (const alert of alertResult.tessellationAlerts) {
        log(`[Alert] ${alert.severity.toUpperCase()}: ${alert.message}`);
        await eventPublisher.publishAlert(
          alert.ruleId,
          alert.severity === 'critical' ? 'CRITICAL' : 'WARNING',
          alert.message,
          [alert.nodeIp],
        );
      }

      // Notify on critical alerts
      if (alertResult.hasCritical) {
        const criticalCount =
          alertResult.resourceAlerts.filter(a => a.severity === 'critical').length +
          alertResult.tessellationAlerts.filter(a => a.severity === 'critical').length;
        await notify(config, `🚨 ${criticalCount} critical alert(s) detected — check monitoring dashboard`);
      }
    }
  } catch (err) {
    log(`[Monitor] Error evaluating alerts: ${err}`);
  }

  log('[Monitor] Metagraph is healthy ✓');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const eventPublisher = new EventPublisher(config);

  log('OttoChain Health Monitor starting');
  log(`Nodes: ${config.nodes.map(n => `${n.name}(${n.ip})`).join(', ')}`);
  log(`Mode: ${config.daemon ? 'daemon' : 'single check'}`);
  log(`Interval: ${config.healthCheckIntervalSeconds}s`);

  // Publish lifecycle event
  await eventPublisher.publishLifecycle(true);

  if (config.daemon) {
    // Handle graceful shutdown
    const shutdown = async () => {
      log('[Monitor] Shutting down...');
      await eventPublisher.publishLifecycle(false);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await runHealthCheck(config, eventPublisher);
      } catch (err) {
        log(`[Monitor] Unexpected error: ${err}`);
        await notify(config, `🚨 Monitor error: ${err}`);
      }
      await new Promise(resolve => setTimeout(resolve, config.healthCheckIntervalSeconds * 1000));
    }
  } else {
    await runHealthCheck(config, eventPublisher);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
