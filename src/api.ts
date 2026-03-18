/**
 * Watchdog HTTP API
 *
 * Simple REST API for external integration (e.g., devops agents, dashboards).
 *
 * Endpoints:
 *   GET  /api/status     - Current health status and restart state
 *   GET  /api/history    - Recent restart events
 *   POST /api/reset      - Reset restart suspension (re-enable auto-restarts)
 *   POST /api/restart    - Trigger manual restart (layer or full)
 */

import http from 'http';
import { URL } from 'url';
import { log } from './logger.js';
import {
  isRestartSuspended,
  resetRestartState,
  getRestartState,
} from './restart/orchestrator.js';
import type { Config } from './config.js';

export interface ApiConfig {
  port: number;
  enabled: boolean;
}

export function startApiServer(config: Config, apiConfig: ApiConfig): http.Server | null {
  if (!apiConfig.enabled) {
    log('[API] HTTP API disabled');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${apiConfig.port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (path === '/api/status' && method === 'GET') {
        const state = getRestartState();
        const response = {
          healthy: !isRestartSuspended(),
          suspended: isRestartSuspended(),
          consecutiveFailures: state.consecutiveFailures,
          lastRestartTime: state.lastRestartTime?.toISOString() ?? null,
          lastCondition: state.lastCondition ?? null,
          managedLayers: config.managedLayers,
          nodes: config.nodes.map(n => ({ name: n.name, ip: n.ip })),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response, null, 2));
        return;
      }

      if (path === '/api/reset' && method === 'POST') {
        const wasSuspended = isRestartSuspended();
        resetRestartState();
        log('[API] Restart state reset via API');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          wasSuspended,
          message: wasSuspended
            ? 'Restart suspension cleared — automatic restarts re-enabled'
            : 'Restart state was already active',
        }));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      log(`[API] Error handling ${method} ${path}: ${err}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(apiConfig.port, () => {
    log(`[API] HTTP API listening on port ${apiConfig.port}`);
  });

  return server;
}
