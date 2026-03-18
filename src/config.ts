/**
 * Watchdog configuration.
 *
 * All values can be overridden via environment variables.
 */

import type { Layer } from './types.js';
import { DEFAULT_MANAGED_LAYERS } from './types.js';

export interface NodeConfig {
  /** Human-friendly label */
  name: string;
  ip: string;
}

export interface HypergraphConfig {
  enabled: boolean;
  l0Urls: string[];
  l1Urls?: string[];
  metagraphId?: string;
  checkIntervalMultiplier: number;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

export interface ApiConfig {
  enabled: boolean;
  port: number;
}

export interface Config {
  /** Metagraph nodes (must match cluster size) */
  nodes: NodeConfig[];

  /** Services node (bridge, indexer, explorer, gateway) — optional */
  servicesNode?: NodeConfig;

  /** SSH key path for remote commands */
  sshKeyPath: string;
  sshUser: string;

  /** Layer ports (public API) */
  ports: {
    gl0: number;
    ml0: number;
    cl1: number;
    dl1: number;
  };

  /** CLI ports (internal, for join commands) */
  cliPorts: {
    gl0: number;
    ml0: number;
    cl1: number;
    dl1: number;
  };

  /** P2P ports */
  p2pPorts: {
    gl0: number;
    ml0: number;
    cl1: number;
    dl1: number;
  };

  /** Thresholds */
  snapshotStallMinutes: number;
  healthCheckIntervalSeconds: number;
  restartCooldownMinutes: number;
  maxRestartsPerHour: number;

  /** Redis URL for reading cached health data from services monitor */
  redisUrl: string;

  /** Postgres URL for reading events and writing restart events */
  postgresUrl: string;

  /** Seconds before health data is considered stale (triggers direct fallback) */
  healthDataStaleSeconds: number;

  /** Layers the watchdog manages (can restart). Others are detection-only. */
  managedLayers: Layer[];

  /** Max consecutive restart failures before giving up and alerting */
  maxConsecutiveFailures: number;

  /** Run mode */
  daemon: boolean;
  once: boolean;

  /** Optional hypergraph monitoring */
  hypergraph?: HypergraphConfig;

  /** Optional Telegram notifications */
  telegram?: TelegramConfig;

  /** Optional HTTP API */
  api?: ApiConfig;
}

function buildHypergraphConfig(): HypergraphConfig | undefined {
  const enabled = process.env.HYPERGRAPH_ENABLED === 'true';
  if (!enabled) return undefined;

  const l0Urls = (process.env.HYPERGRAPH_L0_URLS ?? '').split(',').map(u => u.trim()).filter(Boolean);
  if (l0Urls.length === 0) return undefined;

  const l1Raw = process.env.HYPERGRAPH_L1_URLS;
  const l1Urls = l1Raw ? l1Raw.split(',').map(u => u.trim()).filter(Boolean) : undefined;

  return {
    enabled: true,
    l0Urls,
    l1Urls: l1Urls && l1Urls.length > 0 ? l1Urls : undefined,
    metagraphId: process.env.HYPERGRAPH_METAGRAPH_ID || undefined,
    checkIntervalMultiplier: int(process.env.HYPERGRAPH_CHECK_MULTIPLIER, 3),
  };
}

export function loadConfig(): Config {
  const nodeIps = (process.env.NODE_IPS ?? '10.0.0.1,10.0.0.2,10.0.0.3').split(',');
  const nodeNames = (process.env.NODE_NAMES ?? 'node1,node2,node3').split(',');

  const servicesIp = process.env.SERVICES_NODE_IP;

  return {
    nodes: nodeIps.map((ip, i) => ({
      name: nodeNames[i] ?? `node${i + 1}`,
      ip: ip.trim(),
    })),

    servicesNode: servicesIp ? {
      name: process.env.SERVICES_NODE_NAME ?? 'services',
      ip: servicesIp.trim(),
    } : undefined,

    sshKeyPath: process.env.SSH_KEY_PATH ?? '/root/.ssh/hetzner_ottobot',
    sshUser: process.env.SSH_USER ?? 'root',

    ports: {
      gl0: int(process.env.GL0_PORT, 9000),
      ml0: int(process.env.ML0_PORT, 9200),
      cl1: int(process.env.CL1_PORT, 9300),
      dl1: int(process.env.DL1_PORT, 9400),
    },

    cliPorts: {
      gl0: int(process.env.GL0_CLI_PORT, 9002),
      ml0: int(process.env.ML0_CLI_PORT, 9202),
      cl1: int(process.env.CL1_CLI_PORT, 9302),
      dl1: int(process.env.DL1_CLI_PORT, 9402),
    },

    p2pPorts: {
      gl0: int(process.env.GL0_P2P_PORT, 9001),
      ml0: int(process.env.ML0_P2P_PORT, 9201),
      cl1: int(process.env.CL1_P2P_PORT, 9301),
      dl1: int(process.env.DL1_P2P_PORT, 9401),
    },

    snapshotStallMinutes: int(process.env.SNAPSHOT_STALL_MINUTES, 4),
    healthCheckIntervalSeconds: int(process.env.HEALTH_CHECK_INTERVAL, 60),
    restartCooldownMinutes: int(process.env.RESTART_COOLDOWN_MINUTES, 10),
    maxRestartsPerHour: int(process.env.MAX_RESTARTS_PER_HOUR, 6),

    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    postgresUrl: process.env.DATABASE_URL ?? 'postgresql://ottochain:ottochain-local-dev@localhost:5432/ottochain',
    healthDataStaleSeconds: int(process.env.HEALTH_DATA_STALE_SECONDS, 60),

    managedLayers: parseManagedLayers(process.env.MANAGED_LAYERS),
    maxConsecutiveFailures: int(process.env.MAX_CONSECUTIVE_FAILURES, 3),

    daemon: process.argv.includes('--daemon'),
    once: process.argv.includes('--once'),

    hypergraph: buildHypergraphConfig(),

    telegram: buildTelegramConfig(),
    api: buildApiConfig(),
  };
}

function buildTelegramConfig(): TelegramConfig | undefined {
  const enabled = process.env.TELEGRAM_ENABLED === 'true';
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';

  if (!enabled || !botToken || !chatId) return undefined;

  return { enabled: true, botToken, chatId };
}

function buildApiConfig(): ApiConfig | undefined {
  const enabled = process.env.API_ENABLED !== 'false'; // Enabled by default
  const port = int(process.env.API_PORT, 3033);

  return { enabled, port };
}

function int(val: string | undefined, fallback: number): number {
  return val ? parseInt(val, 10) : fallback;
}

function parseManagedLayers(val: string | undefined): Layer[] {
  if (!val) return DEFAULT_MANAGED_LAYERS;
  const valid: Layer[] = ['gl0', 'ml0', 'cl1', 'dl1'];
  return val.split(',').map(s => s.trim() as Layer).filter(l => valid.includes(l));
}
