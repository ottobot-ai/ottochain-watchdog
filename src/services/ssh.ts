/**
 * SSH command execution on remote Hetzner nodes.
 *
 * Uses native ssh2 library for non-interactive commands.
 */

import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import type { Config } from '../config.js';
import { log } from '../logger.js';

export async function sshExec(
  ip: string,
  command: string,
  config: Config,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH to ${ip} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }

          let stdout = '';
          let stderr = '';

          stream.on('data', (data: Buffer) => { stdout += data.toString(); });
          stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

          stream.on('close', (code: number) => {
            clearTimeout(timer);
            conn.end();
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
          });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`SSH to ${ip}: ${err.message}`));
      })
      .connect({
        host: ip,
        port: 22,
        username: config.sshUser,
        privateKey: readFileSync(config.sshKeyPath),
      });
  });
}

/** Docker exec on a remote node */
export async function dockerExec(
  ip: string,
  container: string,
  command: string,
  config: Config,
): Promise<string> {
  const result = await sshExec(ip, `docker exec ${container} ${command}`, config);
  if (result.code !== 0) {
    throw new Error(`docker exec ${container} on ${ip} failed (code ${result.code}): ${result.stderr}`);
  }
  return result.stdout;
}

/** Docker stop/start/restart on a remote node */
export async function dockerControl(
  ip: string,
  action: 'stop' | 'start' | 'restart',
  container: string,
  config: Config,
): Promise<void> {
  log(`[SSH] docker ${action} ${container} on ${ip}`);
  const result = await sshExec(ip, `docker ${action} ${container} 2>&1`, config, 60_000);
  if (result.code !== 0) {
    throw new Error(`docker ${action} ${container} on ${ip} failed: ${result.stderr}`);
  }
}

/** Kill Java process in a container (graceful then force) */
export async function killLayerProcess(
  ip: string,
  container: string,
  config: Config,
): Promise<void> {
  log(`[SSH] Killing process in ${container} on ${ip}`);
  // Stop the container (sends SIGTERM, then SIGKILL after grace period)
  await sshExec(ip, `docker stop -t 15 ${container} 2>&1 || true`, config, 30_000);
}
