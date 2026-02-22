/**
 * SSH helpers for remote command execution on Hetzner nodes.
 *
 * Uses ssh2 library. Set DRY_RUN=true to skip actual SSH connections.
 */

import type { MonitorConfig } from './config.js';
import type { NodeInfo, LayerName } from './types.js';

// Lazy-import ssh2 so tests don't need it installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ssh2: any = null;
async function getSsh2() {
  if (!ssh2) {
    ssh2 = await import('ssh2');
  }
  return ssh2;
}

// ── Docker container names per layer ──────────────────────────────────────────

const LAYER_CONTAINER: Record<LayerName, string> = {
  GL0: 'gl0',
  ML0: 'ml0',  // OttoChain metagraph-l0 (built from tessellation currency-l0)
  CL1: 'cl1',
  DL1: 'dl1',
};

// ── Remote execution ──────────────────────────────────────────────────────────

export interface ExecResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
}

/**
 * Execute a shell command on a remote node via SSH.
 * Returns stdout/stderr/exitCode.
 */
export async function remoteExec(
  node:    NodeInfo,
  command: string,
  config:  MonitorConfig
): Promise<ExecResult> {
  if (config.dryRun) {
    console.log(`[ssh][DRY-RUN] node${node.nodeId} (${node.host}): ${command}`);
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  const { Client } = await getSsh2();
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';

    conn.on('ready', () => {
      conn.exec(command, (err: Error, stream: NodeJS.ReadableStream & { stderr: NodeJS.ReadableStream; on(event: 'close', cb: (code: number) => void): void }) => {
        if (err) { conn.end(); reject(err); return; }

        stream.on('close', (code: number) => {
          conn.end();
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
        });

        stream.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        stream.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      });
    });

    conn.on('error', reject);

    conn.connect({
      host:       node.host,
      port:       22,
      username:   config.sshUser,
      privateKey: require('fs').readFileSync(config.sshKeyPath),
    });
  });
}

// ── Layer restart commands ────────────────────────────────────────────────────

/**
 * Get the Docker container name for a layer on a given node.
 * Adjust naming convention to match actual deployment.
 */
export function getContainerName(layer: LayerName, _nodeId: string): string {
  return LAYER_CONTAINER[layer];
}

/**
 * Restart a single layer on a single node.
 * For GL0/CL1 with seedlist, pass seedHost to rejoin.
 */
export async function restartLayerOnNode(
  node:     NodeInfo,
  layer:    LayerName,
  config:   MonitorConfig,
  seedHost?: string
): Promise<void> {
  const container = getContainerName(layer, node.nodeId);
  console.log(`[ssh] Restarting ${layer} on node${node.nodeId} (${node.host}), container=${container}`);

  // Stop the container
  await remoteExec(node, `docker stop ${container} || true`, config);
  // Wait briefly
  await new Promise(r => setTimeout(r, 3000));

  if (seedHost && (layer === 'GL0' || layer === 'CL1' || layer === 'DL1')) {
    // Start with seedlist pointing to seed node
    const layerConfig = node.layers.find((l) => l.name === layer)!;
    const seedUrl = `http://${seedHost}:${layerConfig.port}`;
    await remoteExec(
      node,
      `docker start ${container} && docker exec ${container} sh -c 'echo "seedlist: ${seedUrl}" > /config/seedlist.yaml'`,
      config
    );
  } else {
    await remoteExec(node, `docker start ${container}`, config);
  }

  console.log(`[ssh] ✓ Restarted ${layer} on node${node.nodeId}`);
}

/**
 * Stop a layer container on a node.
 */
export async function stopLayerOnNode(
  node:    NodeInfo,
  layer:   LayerName,
  config:  MonitorConfig
): Promise<void> {
  const container = getContainerName(layer, node.nodeId);
  console.log(`[ssh] Stopping ${layer} on node${node.nodeId} (${node.host})`);
  await remoteExec(node, `docker stop ${container} || true`, config);
}
