/**
 * Resource Alert Tests (Failing — TDD)
 *
 * Spec: docs/stability-swapfile-resource-spec.md
 * Card: 📊 Stability: Node resource profiling (CPU/mem/disk across all 4 nodes) (69962fd9dae)
 *
 * These tests are EXPECTED TO FAIL until the implementation in resource-alerts.ts
 * is completed. They define the acceptance criteria for the alert threshold logic.
 *
 * Implementation tracked by Trello card 69962fd9dae → In Development
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateResourceAlerts,
  calcPct,
  evalSeverity,
  checkProcessAbsent,
  THRESHOLDS,
  type NodeResourceSnapshot,
  type ResourceAlert,
} from './resource-alerts.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const GB = 1024 * 1024 * 1024;

function makeSnapshot(overrides: Partial<NodeResourceSnapshot> = {}): NodeResourceSnapshot {
  return {
    nodeIp: '10.0.0.1',
    ramTotal: 20 * GB,
    ramUsed: 10 * GB,   // 50% — below warning
    swapTotal: 8 * GB,
    swapUsed: 0,        // 0% — no swap used
    diskTotal: 100 * GB,
    diskUsed: 13 * GB,  // 13% — well below warning
    cpuPct: 30,         // 30% — below warning
    layerRss: {
      GL0: 3 * GB,
      ML0: 2 * GB,
      DL1: 1.5 * GB,
      CL1: 1 * GB,
      HOST: null,       // not tracked per-process
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1: calcPct utility
// ---------------------------------------------------------------------------

describe('calcPct', () => {
  it('returns correct percentage for typical values', () => {
    expect(calcPct(14 * GB, 20 * GB)).toBeCloseTo(70, 1);
  });

  it('returns 0 when used is 0', () => {
    expect(calcPct(0, 20 * GB)).toBe(0);
  });

  it('returns 0 when total is 0 (avoid divide-by-zero)', () => {
    expect(calcPct(0, 0)).toBe(0);
  });

  it('returns 100 when fully used', () => {
    expect(calcPct(20 * GB, 20 * GB)).toBe(100);
  });

  it('handles swap values correctly', () => {
    expect(calcPct(4 * GB, 8 * GB)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Group 2: evalSeverity thresholds
// ---------------------------------------------------------------------------

describe('evalSeverity', () => {
  it('returns null when value is below warning threshold', () => {
    expect(evalSeverity(60, THRESHOLDS.ram_warning_pct, THRESHOLDS.ram_critical_pct)).toBeNull();
  });

  it('returns "warning" when value meets warning threshold', () => {
    expect(evalSeverity(70, THRESHOLDS.ram_warning_pct, THRESHOLDS.ram_critical_pct)).toBe('warning');
  });

  it('returns "warning" when value is between warning and critical', () => {
    expect(evalSeverity(75, THRESHOLDS.ram_warning_pct, THRESHOLDS.ram_critical_pct)).toBe('warning');
  });

  it('returns "critical" when value meets critical threshold', () => {
    expect(evalSeverity(85, THRESHOLDS.ram_warning_pct, THRESHOLDS.ram_critical_pct)).toBe('critical');
  });

  it('returns "critical" when value exceeds critical threshold', () => {
    expect(evalSeverity(95, THRESHOLDS.ram_warning_pct, THRESHOLDS.ram_critical_pct)).toBe('critical');
  });

  it('uses correct swap thresholds', () => {
    expect(evalSeverity(49, THRESHOLDS.swap_warning_pct, THRESHOLDS.swap_critical_pct)).toBeNull();
    expect(evalSeverity(50, THRESHOLDS.swap_warning_pct, THRESHOLDS.swap_critical_pct)).toBe('warning');
    expect(evalSeverity(80, THRESHOLDS.swap_warning_pct, THRESHOLDS.swap_critical_pct)).toBe('critical');
  });

  it('uses correct disk thresholds', () => {
    expect(evalSeverity(69, THRESHOLDS.disk_warning_pct, THRESHOLDS.disk_critical_pct)).toBeNull();
    expect(evalSeverity(70, THRESHOLDS.disk_warning_pct, THRESHOLDS.disk_critical_pct)).toBe('warning');
    expect(evalSeverity(85, THRESHOLDS.disk_warning_pct, THRESHOLDS.disk_critical_pct)).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// Group 3: RAM alert evaluation
// ---------------------------------------------------------------------------

describe('evaluateResourceAlerts — RAM', () => {
  it('returns no alerts when RAM usage is below warning threshold', () => {
    const snapshot = makeSnapshot({ ramUsed: 10 * GB }); // 50%
    const alerts = evaluateResourceAlerts(snapshot);
    const ramAlerts = alerts.filter(a => a.metric === 'ram_pct');
    expect(ramAlerts).toHaveLength(0);
  });

  it('fires WARNING alert when RAM > 70%', () => {
    const snapshot = makeSnapshot({ ramUsed: 14.5 * GB }); // 72.5%
    const alerts = evaluateResourceAlerts(snapshot);
    const ramAlert = alerts.find(a => a.metric === 'ram_pct');
    expect(ramAlert).toBeDefined();
    expect(ramAlert!.severity).toBe('warning');
    expect(ramAlert!.nodeIp).toBe('10.0.0.1');
    expect(ramAlert!.threshold).toBe(THRESHOLDS.ram_warning_pct);
  });

  it('fires CRITICAL alert when RAM > 85%', () => {
    const snapshot = makeSnapshot({ ramUsed: 18 * GB }); // 90%
    const alerts = evaluateResourceAlerts(snapshot);
    const ramAlert = alerts.find(a => a.metric === 'ram_pct');
    expect(ramAlert).toBeDefined();
    expect(ramAlert!.severity).toBe('critical');
  });

  it('alert includes computed value percentage', () => {
    const snapshot = makeSnapshot({ ramUsed: 17 * GB }); // 85%
    const alerts = evaluateResourceAlerts(snapshot);
    const ramAlert = alerts.find(a => a.metric === 'ram_pct');
    expect(ramAlert).toBeDefined();
    expect(ramAlert!.value).toBeCloseTo(85, 0);
  });
});

// ---------------------------------------------------------------------------
// Group 4: Swap alert evaluation
// ---------------------------------------------------------------------------

describe('evaluateResourceAlerts — Swap', () => {
  it('returns no alerts when swap usage is 0', () => {
    const snapshot = makeSnapshot({ swapUsed: 0 });
    const alerts = evaluateResourceAlerts(snapshot);
    const swapAlerts = alerts.filter(a => a.metric === 'swap_pct');
    expect(swapAlerts).toHaveLength(0);
  });

  it('fires WARNING alert when swap > 50%', () => {
    const snapshot = makeSnapshot({ swapUsed: 4.5 * GB }); // 56.25%
    const alerts = evaluateResourceAlerts(snapshot);
    const swapAlert = alerts.find(a => a.metric === 'swap_pct');
    expect(swapAlert).toBeDefined();
    expect(swapAlert!.severity).toBe('warning');
  });

  it('fires CRITICAL alert when swap > 80%', () => {
    const snapshot = makeSnapshot({ swapUsed: 7 * GB }); // 87.5%
    const alerts = evaluateResourceAlerts(snapshot);
    const swapAlert = alerts.find(a => a.metric === 'swap_pct');
    expect(swapAlert).toBeDefined();
    expect(swapAlert!.severity).toBe('critical');
  });

  it('returns no swap alerts when swapTotal is 0 (no swap configured)', () => {
    const snapshot = makeSnapshot({ swapTotal: 0, swapUsed: 0 });
    const alerts = evaluateResourceAlerts(snapshot);
    const swapAlerts = alerts.filter(a => a.metric === 'swap_pct');
    expect(swapAlerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Disk alert evaluation
// ---------------------------------------------------------------------------

describe('evaluateResourceAlerts — Disk', () => {
  it('returns no alerts when disk usage is below warning threshold', () => {
    const snapshot = makeSnapshot({ diskUsed: 13 * GB }); // 13%
    const alerts = evaluateResourceAlerts(snapshot);
    const diskAlerts = alerts.filter(a => a.metric === 'disk_pct');
    expect(diskAlerts).toHaveLength(0);
  });

  it('fires WARNING alert when disk > 70%', () => {
    const snapshot = makeSnapshot({ diskUsed: 75 * GB }); // 75%
    const alerts = evaluateResourceAlerts(snapshot);
    const diskAlert = alerts.find(a => a.metric === 'disk_pct');
    expect(diskAlert).toBeDefined();
    expect(diskAlert!.severity).toBe('warning');
  });

  it('fires CRITICAL alert when disk > 85%', () => {
    const snapshot = makeSnapshot({ diskUsed: 90 * GB }); // 90%
    const alerts = evaluateResourceAlerts(snapshot);
    const diskAlert = alerts.find(a => a.metric === 'disk_pct');
    expect(diskAlert).toBeDefined();
    expect(diskAlert!.severity).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// Group 6: CPU alert evaluation
// ---------------------------------------------------------------------------

describe('evaluateResourceAlerts — CPU', () => {
  it('returns no alerts when CPU is below threshold', () => {
    const snapshot = makeSnapshot({ cpuPct: 30 });
    const alerts = evaluateResourceAlerts(snapshot);
    const cpuAlerts = alerts.filter(a => a.metric === 'cpu_pct');
    expect(cpuAlerts).toHaveLength(0);
  });

  it('fires WARNING alert when CPU > 90%', () => {
    const snapshot = makeSnapshot({ cpuPct: 95 });
    const alerts = evaluateResourceAlerts(snapshot);
    const cpuAlert = alerts.find(a => a.metric === 'cpu_pct');
    expect(cpuAlert).toBeDefined();
    expect(cpuAlert!.severity).toBe('warning');
    expect(cpuAlert!.layer).toBe('HOST');
  });
});

// ---------------------------------------------------------------------------
// Group 7: Process absent checks
// ---------------------------------------------------------------------------

describe('checkProcessAbsent', () => {
  it('returns null when layer is running (RSS is non-null number)', () => {
    const snapshot = makeSnapshot();
    const result = checkProcessAbsent(snapshot, 'GL0');
    expect(result).toBeNull();
  });

  it('returns alert when layer is absent (RSS is null)', () => {
    const snapshot = makeSnapshot({
      layerRss: { GL0: null, ML0: 2 * GB, DL1: 1.5 * GB, CL1: 1 * GB },
    });
    const result = checkProcessAbsent(snapshot, 'GL0');
    expect(result).not.toBeNull();
    expect(result!.metric).toBe('process_absent');
    expect(result!.severity).toBe('warning');
    expect(result!.layer).toBe('GL0');
    expect(result!.nodeIp).toBe('10.0.0.1');
  });

  it('CL1 absent fires alert (currently known P0 condition)', () => {
    const snapshot = makeSnapshot({
      layerRss: { GL0: 3 * GB, ML0: 2 * GB, DL1: 1.5 * GB, CL1: null },
    });
    const result = checkProcessAbsent(snapshot, 'CL1');
    expect(result).not.toBeNull();
    expect(result!.metric).toBe('process_absent');
    expect(result!.layer).toBe('CL1');
  });
});

// ---------------------------------------------------------------------------
// Group 8: evaluateResourceAlerts — combined / edge cases
// ---------------------------------------------------------------------------

describe('evaluateResourceAlerts — combined', () => {
  it('returns empty array when all metrics are healthy', () => {
    const snapshot = makeSnapshot();
    const alerts = evaluateResourceAlerts(snapshot);
    const nonProcessAlerts = alerts.filter(a => a.metric !== 'process_absent');
    expect(nonProcessAlerts).toHaveLength(0);
  });

  it('returns multiple alerts when multiple metrics are in violation', () => {
    const snapshot = makeSnapshot({
      ramUsed: 18 * GB,   // 90% — critical
      swapUsed: 7 * GB,   // 87.5% — critical
      diskUsed: 75 * GB,  // 75% — warning
      cpuPct: 95,          // 95% — warning
    });
    const alerts = evaluateResourceAlerts(snapshot);
    const types = alerts.map(a => a.metric);
    expect(types).toContain('ram_pct');
    expect(types).toContain('swap_pct');
    expect(types).toContain('disk_pct');
    expect(types).toContain('cpu_pct');
    expect(alerts.length).toBeGreaterThanOrEqual(4);
  });

  it('alert message is human-readable and includes nodeIp', () => {
    const snapshot = makeSnapshot({ ramUsed: 18 * GB });
    const alerts = evaluateResourceAlerts(snapshot);
    const ramAlert = alerts.find(a => a.metric === 'ram_pct');
    expect(ramAlert).toBeDefined();
    expect(ramAlert!.message).toContain('10.0.0.1');
    expect(ramAlert!.message.length).toBeGreaterThan(10);
  });

  it('each alert has all required fields', () => {
    const snapshot = makeSnapshot({ ramUsed: 18 * GB });
    const alerts = evaluateResourceAlerts(snapshot);
    for (const alert of alerts) {
      expect(alert).toHaveProperty('nodeIp');
      expect(alert).toHaveProperty('layer');
      expect(alert).toHaveProperty('metric');
      expect(alert).toHaveProperty('value');
      expect(alert).toHaveProperty('threshold');
      expect(alert).toHaveProperty('severity');
      expect(alert).toHaveProperty('message');
    }
  });
});
