/**
 * Resource Alert Thresholds
 *
 * Monitors RAM, swap, disk, and CPU usage across all cluster nodes.
 * Spec: docs/stability-swapfile-resource-spec.md
 * Card: 📊 Stability: Node resource profiling (69962fd9dae)
 */

/** Alert severity levels */
export type Severity = 'warning' | 'critical';

/** Cluster layer identifiers */
export type MonitorLayer = 'GL0' | 'ML0' | 'DL1' | 'CL1' | 'HOST';

/** Metric types for resource monitoring */
export type MetricType =
  | 'ram_pct'
  | 'swap_pct'
  | 'disk_pct'
  | 'cpu_pct'
  | 'process_absent';

/** A resource alert fired when a threshold is crossed */
export interface ResourceAlert {
  nodeIp: string;
  layer: MonitorLayer;
  metric: MetricType;
  value: number;
  threshold: number;
  severity: Severity;
  message: string;
}

/** Raw resource metrics snapshot from a node */
export interface NodeResourceSnapshot {
  /** Node IP address */
  nodeIp: string;
  /** Total RAM in bytes */
  ramTotal: number;
  /** Used RAM in bytes */
  ramUsed: number;
  /** Total swap in bytes */
  swapTotal: number;
  /** Used swap in bytes */
  swapUsed: number;
  /** Total disk in bytes */
  diskTotal: number;
  /** Used disk in bytes */
  diskUsed: number;
  /** CPU usage percentage (0–100) */
  cpuPct: number;
  /** Per-layer RSS in bytes (null if layer not running) */
  layerRss: Partial<Record<MonitorLayer, number | null>>;
}

/** Threshold configuration */
export const THRESHOLDS = {
  ram_warning_pct:   70,
  ram_critical_pct:  85,
  swap_warning_pct:  50,
  swap_critical_pct: 80,
  disk_warning_pct:  70,
  disk_critical_pct: 85,
  cpu_warning_pct:   90,
} as const;

/**
 * Calculate percentage from used/total bytes.
 * Returns 0 if total is 0 to avoid division by zero.
 */
export function calcPct(used: number, total: number): number {
  if (total === 0) return 0;
  return (used / total) * 100;
}

/**
 * Evaluate severity for a metric value against warning and critical thresholds.
 * Returns null if below both thresholds.
 */
export function evalSeverity(
  value: number,
  warningThreshold: number,
  criticalThreshold: number,
): Severity | null {
  if (value >= criticalThreshold) return 'critical';
  if (value >= warningThreshold) return 'warning';
  return null;
}

/**
 * Check if a layer process is absent (RSS is null) and build alert.
 * Returns null if layer is present or not tracked (undefined).
 */
export function checkProcessAbsent(
  snapshot: NodeResourceSnapshot,
  layer: MonitorLayer,
): ResourceAlert | null {
  const rss = snapshot.layerRss[layer];
  // undefined means not tracked → treat as running (no alert)
  if (rss === undefined) return null;
  // number means process is running
  if (typeof rss === 'number') return null;
  // rss === null → process is absent
  return {
    nodeIp: snapshot.nodeIp,
    layer,
    metric: 'process_absent',
    value: 0,
    threshold: 0,
    severity: 'warning',
    message: `${snapshot.nodeIp}: ${layer} process is absent (RSS null) — check container status`,
  };
}

/**
 * Evaluate resource alerts from a node snapshot.
 * Returns an array of alerts for any threshold crossings.
 */
export function evaluateResourceAlerts(snapshot: NodeResourceSnapshot): ResourceAlert[] {
  const alerts: ResourceAlert[] = [];
  const { nodeIp, ramTotal, ramUsed, swapTotal, swapUsed, diskTotal, diskUsed, cpuPct } = snapshot;

  // --- RAM ---
  const ramPct = calcPct(ramUsed, ramTotal);
  const ramSeverity = evalSeverity(ramPct, THRESHOLDS.ram_warning_pct, THRESHOLDS.ram_critical_pct);
  if (ramSeverity) {
    const threshold = ramSeverity === 'critical'
      ? THRESHOLDS.ram_critical_pct
      : THRESHOLDS.ram_warning_pct;
    alerts.push({
      nodeIp,
      layer: 'HOST',
      metric: 'ram_pct',
      value: ramPct,
      threshold,
      severity: ramSeverity,
      message: `${nodeIp}: RAM usage at ${ramPct.toFixed(1)}% exceeds ${threshold}% threshold (${ramSeverity})`,
    });
  }

  // --- Swap (skip if no swap configured) ---
  if (swapTotal > 0) {
    const swapPct = calcPct(swapUsed, swapTotal);
    const swapSeverity = evalSeverity(swapPct, THRESHOLDS.swap_warning_pct, THRESHOLDS.swap_critical_pct);
    if (swapSeverity) {
      const threshold = swapSeverity === 'critical'
        ? THRESHOLDS.swap_critical_pct
        : THRESHOLDS.swap_warning_pct;
      alerts.push({
        nodeIp,
        layer: 'HOST',
        metric: 'swap_pct',
        value: swapPct,
        threshold,
        severity: swapSeverity,
        message: `${nodeIp}: Swap usage at ${swapPct.toFixed(1)}% exceeds ${threshold}% threshold (${swapSeverity})`,
      });
    }
  }

  // --- Disk ---
  const diskPct = calcPct(diskUsed, diskTotal);
  const diskSeverity = evalSeverity(diskPct, THRESHOLDS.disk_warning_pct, THRESHOLDS.disk_critical_pct);
  if (diskSeverity) {
    const threshold = diskSeverity === 'critical'
      ? THRESHOLDS.disk_critical_pct
      : THRESHOLDS.disk_warning_pct;
    alerts.push({
      nodeIp,
      layer: 'HOST',
      metric: 'disk_pct',
      value: diskPct,
      threshold,
      severity: diskSeverity,
      message: `${nodeIp}: Disk usage at ${diskPct.toFixed(1)}% exceeds ${threshold}% threshold (${diskSeverity})`,
    });
  }

  // --- CPU (warning-only, no critical threshold) ---
  if (cpuPct >= THRESHOLDS.cpu_warning_pct) {
    alerts.push({
      nodeIp,
      layer: 'HOST',
      metric: 'cpu_pct',
      value: cpuPct,
      threshold: THRESHOLDS.cpu_warning_pct,
      severity: 'warning',
      message: `${nodeIp}: CPU usage at ${cpuPct}% exceeds ${THRESHOLDS.cpu_warning_pct}% threshold (warning)`,
    });
  }

  // --- Process absence: check metagraph layers only (HOST is not a tracked process) ---
  const layersToCheck: MonitorLayer[] = ['GL0', 'ML0', 'DL1', 'CL1'];
  for (const layer of layersToCheck) {
    const absent = checkProcessAbsent(snapshot, layer);
    if (absent) alerts.push(absent);
  }

  return alerts;
}
