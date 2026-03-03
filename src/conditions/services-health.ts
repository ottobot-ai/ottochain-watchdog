/**
 * Services Node Health Detection
 *
 * Monitors Docker container health on the services node (bridge, indexer,
 * explorer, gateway, postgres, redis). Detection-only — no auto-restart
 * for services containers (too risky without coordination).
 */

import type { Config } from '../config.js';
import type { DetectionResult } from '../types.js';
import { sshExec } from '../services/ssh.js';
import { log } from '../logger.js';

/** Expected containers on the services node */
const REQUIRED_CONTAINERS = [
  'bridge',
  'indexer',
  'explorer',
  'gateway',
  'postgres',
  'redis',
];

/** Optional containers — warn if unhealthy but don't flag as missing */
const OPTIONAL_CONTAINERS = [
  'watchdog',
  'monitor',
  'traffic-gen',
  'prometheus',
  'alertmanager',
  'grafana',
  'loki',
  'node-exporter',
  'redis-exporter',
  'postgres-exporter',
];

interface ContainerStatus {
  name: string;
  status: string;  // "Up 2 hours", "Up 2 hours (healthy)", "Up 2 hours (unhealthy)", "Exited (1) ..."
  running: boolean;
  healthy: boolean | null;  // null = no healthcheck defined
}

function parseContainerLine(line: string): ContainerStatus | null {
  // Format: name|status
  const parts = line.split('|');
  if (parts.length < 2) return null;
  const name = parts[0].trim();
  const status = parts[1].trim();
  const running = status.startsWith('Up');
  const healthy = status.includes('(healthy)') ? true
    : status.includes('(unhealthy)') ? false
    : null;
  return { name, status, running, healthy };
}

export async function detectServicesHealth(config: Config): Promise<DetectionResult> {
  const servicesIp = config.servicesNode?.ip;

  if (!servicesIp) {
    return { detected: false, condition: 'ServicesHealth', details: 'No services node configured', restartScope: 'none' };
  }

  log('[ServicesHealth] Checking containers on services node...');

  try {
    const { stdout, code } = await sshExec(
      servicesIp,
      'docker ps -a --format "{{.Names}}|{{.Status}}"',
      config,
      15_000,
    );

    if (code !== 0) {
      return {
        detected: true,
        condition: 'ServicesHealth',
        details: `SSH to services node returned code ${code}`,
        restartScope: 'none',
      };
    }

    const containers = stdout
      .trim()
      .split('\n')
      .map(parseContainerLine)
      .filter((c): c is ContainerStatus => c !== null);

    const containerMap = new Map(containers.map(c => [c.name, c]));

    const problems: string[] = [];

    // Check required containers
    for (const name of REQUIRED_CONTAINERS) {
      const c = containerMap.get(name);
      if (!c) {
        problems.push(`${name}: MISSING`);
        log(`[ServicesHealth] ${name}: MISSING (not found)`);
      } else if (!c.running) {
        problems.push(`${name}: STOPPED (${c.status})`);
        log(`[ServicesHealth] ${name}: STOPPED — ${c.status}`);
      } else if (c.healthy === false) {
        problems.push(`${name}: UNHEALTHY`);
        log(`[ServicesHealth] ${name}: UNHEALTHY — ${c.status}`);
      }
    }

    // Check optional containers (only if present + unhealthy)
    for (const name of OPTIONAL_CONTAINERS) {
      const c = containerMap.get(name);
      if (c && !c.running) {
        problems.push(`${name}: STOPPED (optional)`);
        log(`[ServicesHealth] ${name}: STOPPED (optional) — ${c.status}`);
      } else if (c && c.healthy === false) {
        problems.push(`${name}: UNHEALTHY (optional)`);
        log(`[ServicesHealth] ${name}: UNHEALTHY (optional) — ${c.status}`);
      }
    }

    // Also check disk and memory
    const { stdout: diskOut } = await sshExec(
      servicesIp,
      "df -h / | awk 'NR==2{print $5}'",
      config,
      10_000,
    );
    const diskPct = parseInt(diskOut.trim().replace('%', ''));
    if (diskPct > 85) {
      problems.push(`disk: ${diskPct}% used`);
      log(`[ServicesHealth] Disk warning: ${diskPct}% used`);
    }

    const { stdout: memOut } = await sshExec(
      servicesIp,
      "free -m | awk '/Mem:/{printf \"%d\", $3/$2*100}'",
      config,
      10_000,
    );
    const memPct = parseInt(memOut.trim());
    if (memPct > 90) {
      problems.push(`memory: ${memPct}% used`);
      log(`[ServicesHealth] Memory warning: ${memPct}% used`);
    }

    if (problems.length === 0) {
      log(`[ServicesHealth] All ${REQUIRED_CONTAINERS.length} required containers healthy`);
      return {
        detected: false,
        condition: 'ServicesHealth',
        details: 'All services containers healthy',
        restartScope: 'none',
      };
    }

    return {
      detected: true,
      condition: 'ServicesHealth',
      details: problems.join('; '),
      restartScope: 'none',  // Detection only — don't auto-restart services
      affectedNodes: [servicesIp],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[ServicesHealth] Failed to check services node: ${msg}`);
    return {
      detected: true,
      condition: 'ServicesHealth',
      details: `Services node unreachable: ${msg}`,
      restartScope: 'none',
      affectedNodes: [servicesIp],
    };
  }
}
