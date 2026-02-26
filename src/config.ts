/**
 * Health monitor configuration.
 *
 * All values can be overridden via environment variables.
 */

export interface NodeConfig {
  /** Human-friendly label */
  name: string;
  ip: string;
}

export interface Config {
  /** Metagraph nodes (must match cluster size) */
  nodes: NodeConfig[];

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

  /** Notification webhook (Discord/Telegram) */
  webhookUrl?: string;

  /** Monitor service URL (for publishing events to status page) */
  monitorUrl?: string;
  monitorApiKey?: string;

  /** Run mode */
  daemon: boolean;
  once: boolean;
}

export function loadConfig(): Config {
  const nodeIps = (process.env.NODE_IPS ?? '10.0.0.1,10.0.0.2,10.0.0.3').split(',');
  const nodeNames = (process.env.NODE_NAMES ?? 'node1,node2,node3').split(',');

  return {
    nodes: nodeIps.map((ip, i) => ({
      name: nodeNames[i] ?? `node${i + 1}`,
      ip: ip.trim(),
    })),

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

    webhookUrl: process.env.WEBHOOK_URL,
    monitorUrl: process.env.MONITOR_URL,  // e.g., http://localhost:3032
    monitorApiKey: process.env.MONITOR_API_KEY,

    daemon: process.argv.includes('--daemon'),
    once: process.argv.includes('--once'),
  };
}

function int(val: string | undefined, fallback: number): number {
  return val ? parseInt(val, 10) : fallback;
}
