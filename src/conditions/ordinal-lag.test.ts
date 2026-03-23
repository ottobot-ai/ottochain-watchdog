import { describe, it, expect, beforeEach } from 'vitest';
import { detectOrdinalLagFromSnapshot } from './ordinal-lag.js';
import type { Config, HealthSnapshot, NodeHealthData } from '../types.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodes: [
      { ip: '10.0.0.1', name: 'node1' },
      { ip: '10.0.0.2', name: 'node2' },
      { ip: '10.0.0.3', name: 'node3' },
    ],
    sshKeyPath: '/tmp/test',
    sshUser: 'root',
    ports: { gl0: 9000, ml0: 9200, cl1: 9300, dl1: 9400 },
    cliPorts: { gl0: 9002, ml0: 9202, cl1: 9302, dl1: 9402 },
    p2pPorts: { gl0: 9001, ml0: 9201, cl1: 9301, dl1: 9401 },
    snapshotStallMinutes: 4,
    healthCheckIntervalSeconds: 60,
    restartCooldownMinutes: 5,
    maxRestartsPerHour: 3,
    ...overrides,
  } as Config;
}

function makeNode(ip: string, layers: { layer: string; ordinal: number; state?: string; reachable?: boolean }[]): NodeHealthData {
  return {
    ip,
    name: ip,
    layers: layers.map(l => ({
      layer: l.layer as any,
      ordinal: l.ordinal,
      state: l.state ?? 'Ready',
      reachable: l.reachable ?? true,
      clusterSize: 3,
    })),
  };
}

function makeSnapshot(nodes: NodeHealthData[]): HealthSnapshot {
  return { timestamp: new Date(), nodes, stale: false, source: 'direct' };
}

describe('detectOrdinalLagFromSnapshot', () => {
  const config = makeConfig();

  it('returns not detected when all nodes are in sync', () => {
    const snapshot = makeSnapshot([
      makeNode('10.0.0.1', [{ layer: 'gl0', ordinal: 1000 }, { layer: 'ml0', ordinal: 500 }]),
      makeNode('10.0.0.2', [{ layer: 'gl0', ordinal: 1000 }, { layer: 'ml0', ordinal: 500 }]),
      makeNode('10.0.0.3', [{ layer: 'gl0', ordinal: 1000 }, { layer: 'ml0', ordinal: 500 }]),
    ]);
    const result = detectOrdinalLagFromSnapshot(config, snapshot);
    expect(result.detected).toBe(false);
  });

  it('returns not detected when lag is below threshold', () => {
    const snapshot = makeSnapshot([
      makeNode('10.0.0.1', [{ layer: 'gl0', ordinal: 1000 }]),
      makeNode('10.0.0.2', [{ layer: 'gl0', ordinal: 1010 }]),
      makeNode('10.0.0.3', [{ layer: 'gl0', ordinal: 1010 }]),
    ]);
    const result = detectOrdinalLagFromSnapshot(config, snapshot);
    expect(result.detected).toBe(false);
  });

  it('tracks but does not trigger on first detection (needs duration)', () => {
    const snapshot = makeSnapshot([
      makeNode('10.0.0.1', [{ layer: 'gl0', ordinal: 500 }]),
      makeNode('10.0.0.2', [{ layer: 'gl0', ordinal: 1000 }]),
      makeNode('10.0.0.3', [{ layer: 'gl0', ordinal: 1000 }]),
    ]);
    const result = detectOrdinalLagFromSnapshot(config, snapshot);
    // First detection — tracking started but duration not met
    expect(result.detected).toBe(false);
  });

  it('clears tracking when node catches up', () => {
    // First: node is lagging
    const snapshot1 = makeSnapshot([
      makeNode('10.0.0.1', [{ layer: 'ml0', ordinal: 100 }]),
      makeNode('10.0.0.2', [{ layer: 'ml0', ordinal: 500 }]),
      makeNode('10.0.0.3', [{ layer: 'ml0', ordinal: 500 }]),
    ]);
    detectOrdinalLagFromSnapshot(config, snapshot1);

    // Then: node catches up
    const snapshot2 = makeSnapshot([
      makeNode('10.0.0.1', [{ layer: 'ml0', ordinal: 500 }]),
      makeNode('10.0.0.2', [{ layer: 'ml0', ordinal: 510 }]),
      makeNode('10.0.0.3', [{ layer: 'ml0', ordinal: 510 }]),
    ]);
    const result = detectOrdinalLagFromSnapshot(config, snapshot2);
    expect(result.detected).toBe(false);
  });

  it('ignores unreachable nodes', () => {
    const snapshot = makeSnapshot([
      makeNode('10.0.0.1', [{ layer: 'gl0', ordinal: 500, reachable: false }]),
      makeNode('10.0.0.2', [{ layer: 'gl0', ordinal: 1000 }]),
      makeNode('10.0.0.3', [{ layer: 'gl0', ordinal: 1000 }]),
    ]);
    const result = detectOrdinalLagFromSnapshot(config, snapshot);
    expect(result.detected).toBe(false);
  });

  it('ignores non-Ready nodes', () => {
    const snapshot = makeSnapshot([
      makeNode('10.0.0.1', [{ layer: 'gl0', ordinal: 500, state: 'WaitingForDownload' }]),
      makeNode('10.0.0.2', [{ layer: 'gl0', ordinal: 1000 }]),
      makeNode('10.0.0.3', [{ layer: 'gl0', ordinal: 1000 }]),
    ]);
    const result = detectOrdinalLagFromSnapshot(config, snapshot);
    expect(result.detected).toBe(false);
  });

  it('checks GL0, ML0, and DL1 layers', () => {
    // All synced on GL0/ML0 but not DL1 — should track DL1 lag
    const snapshot = makeSnapshot([
      makeNode('10.0.0.1', [
        { layer: 'gl0', ordinal: 1000 },
        { layer: 'ml0', ordinal: 500 },
        { layer: 'dl1', ordinal: 100 },
      ]),
      makeNode('10.0.0.2', [
        { layer: 'gl0', ordinal: 1000 },
        { layer: 'ml0', ordinal: 500 },
        { layer: 'dl1', ordinal: 500 },
      ]),
      makeNode('10.0.0.3', [
        { layer: 'gl0', ordinal: 1000 },
        { layer: 'ml0', ordinal: 500 },
        { layer: 'dl1', ordinal: 500 },
      ]),
    ]);
    // First call just tracks
    const result = detectOrdinalLagFromSnapshot(config, snapshot);
    expect(result.detected).toBe(false);
    // Condition is "OrdinalLag"
    expect(result.condition).toBe('OrdinalLag');
  });

  it('uses individual-node restart scope', () => {
    // We need to simulate time passing — use the config override
    const fastConfig = makeConfig({ ordinalLagDurationSecs: 0 } as any);
    const snapshot = makeSnapshot([
      makeNode('10.0.0.1', [{ layer: 'gl0', ordinal: 100 }]),
      makeNode('10.0.0.2', [{ layer: 'gl0', ordinal: 1000 }]),
      makeNode('10.0.0.3', [{ layer: 'gl0', ordinal: 1000 }]),
    ]);
    // First call starts tracking
    detectOrdinalLagFromSnapshot(fastConfig, snapshot);
    // Second call with 0 duration threshold triggers immediately
    const result = detectOrdinalLagFromSnapshot(fastConfig, snapshot);
    expect(result.detected).toBe(true);
    expect(result.restartScope).toBe('individual-node');
    expect(result.affectedNodes).toContain('10.0.0.1');
    expect(result.affectedLayers).toContain('gl0');
  });
});
