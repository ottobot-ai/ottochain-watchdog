/**
 * Health Data Reader
 *
 * Reads health data from Redis (cached by services monitor) and Postgres (events).
 * Falls back to direct node HTTP checks if Redis is stale or unavailable.
 *
 * Primary data flow:
 *   Services Monitor → Redis → Watchdog (this reader)
 *
 * Fallback:
 *   Tessellation Nodes → /node/info HTTP → Watchdog (direct poll)
 */

import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import type { Layer } from '../types.js';
import { checkLayerHealth, getLatestOrdinal } from './node-api.js';
import { log } from '../logger.js';

/** Redis key where services monitor writes latest health data */
const HEALTH_KEY = 'monitor:health:latest';

/** Layer health from a single node */
export interface LayerHealth {
  layer: Layer;
  state: string;
  ordinal: number;
  reachable: boolean;
  clusterSize: number;
  clusterHash?: string;
}

/** Health data for a single node */
export interface NodeHealthData {
  ip: string;
  name: string;
  layers: LayerHealth[];
}

/** Complete health snapshot */
export interface HealthSnapshot {
  timestamp: Date;
  nodes: NodeHealthData[];
  stale: boolean;
  source: 'redis' | 'direct';
}

/** Redis health data format (as written by services monitor) */
interface RedisHealthPayload {
  timestamp: string;
  nodes: Array<{
    ip: string;
    name: string;
    layers: Array<{
      layer: string;
      state: string;
      ordinal: number;
      reachable: boolean;
      clusterSize?: number;
      clusterHash?: string;
    }>;
  }>;
}

/**
 * HealthReader class
 *
 * Manages Redis connection and provides health data reading with fallback.
 */
export class HealthReader {
  private redis: Redis | null = null;
  private config: Config;
  private redisAvailable: boolean = true;
  private lastRedisError: Date | null = null;

  constructor(config: Config) {
    this.config = config;
    this.initRedis();
  }

  private initRedis(): void {
    if (!this.config.redisUrl) {
      log('[HealthReader] No Redis URL configured, using direct HTTP fallback');
      this.redisAvailable = false;
      return;
    }

    try {
      this.redis = new Redis(this.config.redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        commandTimeout: 3000,
        lazyConnect: true,
        retryStrategy: (times: number) => {
          if (times > 3) {
            log('[HealthReader] Redis connection failed, falling back to direct checks');
            return null; // Stop retrying
          }
          return Math.min(times * 200, 1000);
        },
      });

      this.redis?.on('error', (err: Error) => {
        if (this.redisAvailable) {
          log(`[HealthReader] Redis error: ${err.message}`);
          this.redisAvailable = false;
          this.lastRedisError = new Date();
        }
      });

      this.redis?.on('connect', () => {
        if (!this.redisAvailable) {
          log('[HealthReader] Redis reconnected');
        }
        this.redisAvailable = true;
      });
    } catch (err) {
      log(`[HealthReader] Failed to initialize Redis: ${err}`);
      this.redisAvailable = false;
    }
  }

  /**
   * Get health snapshot.
   * Tries Redis first, falls back to direct HTTP if stale or unavailable.
   */
  async getHealthSnapshot(): Promise<HealthSnapshot> {
    // Try Redis first
    if (this.redis && this.redisAvailable) {
      try {
        const data = await this.redis.get(HEALTH_KEY);
        if (data) {
          const parsed = JSON.parse(data) as RedisHealthPayload;
          const timestamp = new Date(parsed.timestamp);
          const ageSeconds = (Date.now() - timestamp.getTime()) / 1000;

          if (ageSeconds < this.config.healthDataStaleSeconds) {
            // Fresh data from Redis
            return {
              timestamp,
              nodes: this.transformRedisNodes(parsed.nodes),
              stale: false,
              source: 'redis',
            };
          } else {
            log(`[HealthReader] Redis data stale (${ageSeconds.toFixed(0)}s old), falling back to direct checks`);
          }
        } else {
          log('[HealthReader] No health data in Redis, falling back to direct checks');
        }
      } catch (err) {
        log(`[HealthReader] Redis read failed: ${err}, falling back to direct checks`);
      }
    }

    // Fallback to direct HTTP polling
    return this.pollDirectly();
  }

  /**
   * Transform Redis payload to our internal format.
   */
  private transformRedisNodes(nodes: RedisHealthPayload['nodes']): NodeHealthData[] {
    return nodes.map(n => ({
      ip: n.ip,
      name: n.name,
      layers: n.layers.map(l => ({
        layer: l.layer as Layer,
        state: l.state,
        ordinal: l.ordinal,
        reachable: l.reachable,
        clusterSize: l.clusterSize ?? 0,
        clusterHash: l.clusterHash,
      })),
    }));
  }

  /**
   * Poll nodes directly via HTTP (fallback when Redis unavailable/stale).
   */
  private async pollDirectly(): Promise<HealthSnapshot> {
    log('[HealthReader] Using direct HTTP polling (fallback mode)');
    const layers: Layer[] = ['gl0', 'ml0', 'cl1', 'dl1'];
    const nodeHealthMap = new Map<string, NodeHealthData>();

    // Initialize nodes
    for (const node of this.config.nodes) {
      nodeHealthMap.set(node.ip, {
        ip: node.ip,
        name: node.name,
        layers: [],
      });
    }

    // Poll each layer
    for (const layer of layers) {
      const healths = await checkLayerHealth(this.config, layer);

      for (const h of healths) {
        const nodeData = nodeHealthMap.get(h.nodeIp);
        if (nodeData) {
          nodeData.layers.push({
            layer: h.layer,
            state: h.state,
            ordinal: h.ordinal,
            reachable: h.reachable,
            clusterSize: h.cluster.length,
          });
        }
      }
    }

    return {
      timestamp: new Date(),
      nodes: Array.from(nodeHealthMap.values()),
      stale: false,
      source: 'direct',
    };
  }

  /**
   * Get current ML0 ordinal for stall detection.
   * Tries Redis first, then direct.
   */
  async getML0Ordinal(): Promise<{ ordinal: number; nodeIp: string } | null> {
    // Try Redis
    if (this.redis && this.redisAvailable) {
      try {
        const data = await this.redis.get(HEALTH_KEY);
        if (data) {
          const parsed = JSON.parse(data) as RedisHealthPayload;
          const timestamp = new Date(parsed.timestamp);
          const ageSeconds = (Date.now() - timestamp.getTime()) / 1000;

          if (ageSeconds < this.config.healthDataStaleSeconds) {
            // Find first node with ML0 data
            for (const node of parsed.nodes) {
              const ml0 = node.layers.find(l => l.layer === 'ml0' && l.reachable);
              if (ml0) {
                return { ordinal: ml0.ordinal, nodeIp: node.ip };
              }
            }
          }
        }
      } catch {
        // Fall through to direct
      }
    }

    // Direct fallback
    for (const node of this.config.nodes) {
      try {
        const ordinal = await getLatestOrdinal(node.ip, this.config.ports.ml0, 'ml0');
        if (ordinal >= 0) {
          return { ordinal, nodeIp: node.ip };
        }
      } catch {
        // Try next node
      }
    }

    return null;
  }

  /**
   * Close connections.
   */
  async close(): Promise<void> {
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }
  }
}
