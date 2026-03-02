/**
 * Node Resource Monitoring
 *
 * Checks disk and memory on all metagraph nodes.
 * Detection-only — alerts but doesn't restart.
 */

import type { Config } from '../config.js';
import type { DetectionResult } from '../types.js';
import { sshExec } from '../services/ssh.js';
import { log } from '../logger.js';

const DISK_WARN_PCT = 85;
const MEM_WARN_PCT = 90;

export async function detectNodeResourceIssues(config: Config): Promise<DetectionResult> {
  log('[NodeResources] Checking disk/memory across cluster...');

  const problems: string[] = [];
  const affectedNodes: string[] = [];

  for (const node of config.nodes) {
    try {
      const { stdout } = await sshExec(
        node.ip,
        `echo "DISK:$(df -h / | awk 'NR==2{print $5}')";echo "MEM:$(free -m | awk '/Mem:/{printf "%d", $3/$2*100}')"`,
        config,
        10_000,
      );

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        if (line.startsWith('DISK:')) {
          const pct = parseInt(line.replace('DISK:', '').replace('%', ''));
          if (pct > DISK_WARN_PCT) {
            problems.push(`${node.name}: disk ${pct}%`);
            affectedNodes.push(node.ip);
            log(`[NodeResources] ${node.name} (${node.ip}): disk ${pct}% > ${DISK_WARN_PCT}%`);
          }
        }
        if (line.startsWith('MEM:')) {
          const pct = parseInt(line.replace('MEM:', ''));
          if (pct > MEM_WARN_PCT) {
            problems.push(`${node.name}: memory ${pct}%`);
            if (!affectedNodes.includes(node.ip)) affectedNodes.push(node.ip);
            log(`[NodeResources] ${node.name} (${node.ip}): memory ${pct}% > ${MEM_WARN_PCT}%`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      problems.push(`${node.name}: unreachable (${msg})`);
      affectedNodes.push(node.ip);
      log(`[NodeResources] ${node.name} (${node.ip}): SSH failed — ${msg}`);
    }
  }

  if (problems.length === 0) {
    log('[NodeResources] All nodes within resource thresholds');
    return {
      detected: false,
      condition: 'NodeResources',
      details: 'All nodes within resource thresholds',
      restartScope: 'none',
    };
  }

  return {
    detected: true,
    condition: 'NodeResources',
    details: problems.join('; '),
    restartScope: 'none',
    affectedNodes,
  };
}
