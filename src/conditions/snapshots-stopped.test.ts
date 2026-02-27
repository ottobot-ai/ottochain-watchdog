/**
 * Snapshot Stall Detection Tests
 *
 * Tests for ML0 snapshot stall detection logic.
 * Tests both the pure function (snapshot-based) and legacy (direct HTTP) modes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  StallTracker,
  detectSnapshotsStopped,
  detectSnapshotsStoppedFromSnapshot,
  type OrdinalFetchFn,
} from './snapshots-stopped.js';
import type { Config } from '../config.js';
import type { HealthSnapshot, LayerHealth } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(nodeCount: number = 3): Config {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      ip: `10.0.0.${i + 1}`,
      name: `node${i + 1}`,
    })),
    ports: { gl0: 9000, ml0: 9200, cl1: 9300, dl1: 9400 },
    sshKeyPath: '/test/key',
    sshUser: 'test',
    cliPorts: { gl0: 9001, ml0: 9201, cl1: 9301, dl1: 9401 },
    p2pPorts: { gl0: 9010, ml0: 9210, cl1: 9310, dl1: 9410 },
    snapshotStallMinutes: 4,
    healthCheckIntervalSeconds: 60,
    restartCooldownMinutes: 10,
    maxRestartsPerHour: 6,
    redisUrl: 'redis://localhost:6379',
    postgresUrl: '',
    healthDataStaleSeconds: 60,
    daemon: false,
    once: false,
  };
}

function makeSnapshot(nodeData: Array<{
  ip: string;
  ml0Ordinal: number;
  ml0Reachable?: boolean;
}>): HealthSnapshot {
  return {
    timestamp: new Date(),
    stale: false,
    source: 'redis',
    nodes: nodeData.map((n, i) => ({
      ip: n.ip,
      name: `node${i + 1}`,
      layers: [
        {
          layer: 'ml0' as const,
          state: 'Ready',
          ordinal: n.ml0Ordinal,
          reachable: n.ml0Reachable ?? true,
          clusterSize: 3,
        },
      ],
    })),
  };
}

// ---------------------------------------------------------------------------
// StallTracker tests
// ---------------------------------------------------------------------------

describe('StallTracker', () => {
  let tracker: StallTracker;

  beforeEach(() => {
    tracker = new StallTracker();
  });

  it('staleSecs returns null before first update', () => {
    expect(tracker.staleSecs('n1', 'ml0')).toBeNull();
  });

  it('staleSecs is ~0 immediately after update', () => {
    tracker.update('n1', 'ml0', 100);
    const secs = tracker.staleSecs('n1', 'ml0')!;
    expect(secs).toBeLessThan(1);
  });

  it('update returns true when ordinal advances', () => {
    tracker.update('n1', 'ml0', 100);
    const advanced = tracker.update('n1', 'ml0', 101);
    expect(advanced).toBe(true);
  });

  it('update returns false when ordinal does not change', () => {
    tracker.update('n1', 'ml0', 100);
    const same = tracker.update('n1', 'ml0', 100);
    expect(same).toBe(false);
  });

  it('update returns true on first update', () => {
    const first = tracker.update('n1', 'ml0', 100);
    expect(first).toBe(true);
  });

  it('reset clears all state', () => {
    tracker.update('n1', 'ml0', 100);
    tracker.reset();
    expect(tracker.staleSecs('n1', 'ml0')).toBeNull();
  });

  it('tracks multiple node+layer combos independently', () => {
    tracker.update('n1', 'ml0', 50);
    tracker.update('n2', 'gl0', 200);
    expect(tracker.lastOrdinal('n1', 'ml0')).toBe(50);
    expect(tracker.lastOrdinal('n2', 'gl0')).toBe(200);
  });

  it('staleSecs uses provided now parameter', () => {
    const t0 = 1000000;
    tracker.update('n1', 'ml0', 100, t0);
    const secs = tracker.staleSecs('n1', 'ml0', t0 + 30000); // 30s later
    expect(secs).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// detectSnapshotsStoppedFromSnapshot tests (pure function)
// ---------------------------------------------------------------------------

describe('detectSnapshotsStoppedFromSnapshot()', () => {
  it('returns detected=false when ordinal advances', () => {
    const config = makeConfig();
    const tracker = new StallTracker();

    // First check: ordinal 100
    const snapshot1 = makeSnapshot([
      { ip: '10.0.0.1', ml0Ordinal: 100 },
      { ip: '10.0.0.2', ml0Ordinal: 100 },
      { ip: '10.0.0.3', ml0Ordinal: 100 },
    ]);
    const result1 = detectSnapshotsStoppedFromSnapshot(config, snapshot1, tracker);
    expect(result1.detected).toBe(false);

    // Second check: ordinal 101 (advanced)
    const snapshot2 = makeSnapshot([
      { ip: '10.0.0.1', ml0Ordinal: 101 },
      { ip: '10.0.0.2', ml0Ordinal: 101 },
      { ip: '10.0.0.3', ml0Ordinal: 101 },
    ]);
    const result2 = detectSnapshotsStoppedFromSnapshot(config, snapshot2, tracker);
    expect(result2.detected).toBe(false);
  });

  it('returns detected=false when ordinal unchanged but under threshold', () => {
    const config = makeConfig();
    const tracker = new StallTracker();

    // First check establishes baseline
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', ml0Ordinal: 100 },
    ]);
    detectSnapshotsStoppedFromSnapshot(config, snapshot, tracker);

    // Immediate second check — unchanged but fresh
    const result = detectSnapshotsStoppedFromSnapshot(config, snapshot, tracker);
    expect(result.detected).toBe(false);
  });

  it('returns detected=true when stalled past threshold', () => {
    const config = makeConfig();
    config.snapshotStallMinutes = 0.001; // ~60ms threshold for test

    // Create a tracker with old timestamp
    const tracker = new StallTracker();
    const oldTime = Date.now() - 5 * 60 * 1000; // 5 minutes ago
    tracker.update('10.0.0.1', 'ml0', 100, oldTime);

    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', ml0Ordinal: 100 }, // Same ordinal
    ]);

    const result = detectSnapshotsStoppedFromSnapshot(config, snapshot, tracker);
    expect(result.detected).toBe(true);
    expect(result.condition).toBe('SnapshotsStopped');
    expect(result.restartScope).toBe('full-metagraph');
  });

  it('returns unreachable when all nodes fail', () => {
    const config = makeConfig();
    const tracker = new StallTracker();

    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', ml0Ordinal: -1, ml0Reachable: false },
      { ip: '10.0.0.2', ml0Ordinal: -1, ml0Reachable: false },
      { ip: '10.0.0.3', ml0Ordinal: -1, ml0Reachable: false },
    ]);

    const result = detectSnapshotsStoppedFromSnapshot(config, snapshot, tracker);
    expect(result.detected).toBe(false);
    expect(result.details).toBe('ML0 unreachable');
  });

  it('uses first reachable node', () => {
    const config = makeConfig(3);
    const tracker = new StallTracker();

    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', ml0Ordinal: -1, ml0Reachable: false },
      { ip: '10.0.0.2', ml0Ordinal: -1, ml0Reachable: false },
      { ip: '10.0.0.3', ml0Ordinal: 200, ml0Reachable: true },
    ]);

    const result = detectSnapshotsStoppedFromSnapshot(config, snapshot, tracker);
    expect(result.detected).toBe(false);
    expect(tracker.lastOrdinal('10.0.0.3', 'ml0')).toBe(200);
  });

  it('includes all nodes and layers on stall detection', () => {
    const config = makeConfig(3);
    config.snapshotStallMinutes = 0.001;

    const tracker = new StallTracker();
    tracker.update('10.0.0.1', 'ml0', 100, Date.now() - 10 * 60 * 1000);

    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', ml0Ordinal: 100 },
      { ip: '10.0.0.2', ml0Ordinal: 100 },
      { ip: '10.0.0.3', ml0Ordinal: 100 },
    ]);

    const result = detectSnapshotsStoppedFromSnapshot(config, snapshot, tracker);
    expect(result.detected).toBe(true);
    expect(result.affectedNodes).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    expect(result.affectedLayers).toEqual(['ml0', 'cl1', 'dl1']);
  });
});

// ---------------------------------------------------------------------------
// Legacy direct HTTP tests
// ---------------------------------------------------------------------------

describe('detectSnapshotsStopped() [legacy]', () => {
  it('returns detected=false when ordinal advances', async () => {
    const config = makeConfig();
    const tracker = new StallTracker();
    let ordinal = 100;
    const mockFetch: OrdinalFetchFn = async () => ordinal++;

    const result1 = await detectSnapshotsStopped(config, mockFetch, tracker);
    expect(result1.detected).toBe(false);

    const result2 = await detectSnapshotsStopped(config, mockFetch, tracker);
    expect(result2.detected).toBe(false);
  });

  it('returns detected=false when ordinal unchanged but under threshold', async () => {
    const config = makeConfig();
    const tracker = new StallTracker();
    const mockFetch: OrdinalFetchFn = async () => 100; // Always same

    // First call establishes baseline
    await detectSnapshotsStopped(config, mockFetch, tracker);

    // Second call — unchanged but just now
    const result = await detectSnapshotsStopped(config, mockFetch, tracker);
    expect(result.detected).toBe(false);
  });

  it('returns detected=true when stalled past threshold', async () => {
    const config = makeConfig();
    config.snapshotStallMinutes = 0.001; // ~60ms threshold for test

    // Create a tracker with old timestamp
    const tracker = new StallTracker();
    const oldTime = Date.now() - 5 * 60 * 1000; // 5 minutes ago
    tracker.update('10.0.0.1', 'ml0', 100, oldTime);

    const mockFetch: OrdinalFetchFn = async () => 100; // Same ordinal

    const result = await detectSnapshotsStopped(config, mockFetch, tracker);
    expect(result.detected).toBe(true);
    expect(result.condition).toBe('SnapshotsStopped');
    expect(result.restartScope).toBe('full-metagraph');
  });

  it('returns unreachable when all nodes fail', async () => {
    const config = makeConfig();
    const tracker = new StallTracker();
    const mockFetch: OrdinalFetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await detectSnapshotsStopped(config, mockFetch, tracker);
    expect(result.detected).toBe(false);
    expect(result.details).toBe('ML0 unreachable');
  });

  it('tries all nodes until one succeeds', async () => {
    const config = makeConfig(3);
    const tracker = new StallTracker();
    let callCount = 0;
    const mockFetch: OrdinalFetchFn = async (ip) => {
      callCount++;
      if (ip === '10.0.0.1') throw new Error('fail');
      if (ip === '10.0.0.2') throw new Error('fail');
      return 200; // Only node 3 works
    };

    const result = await detectSnapshotsStopped(config, mockFetch, tracker);
    expect(result.detected).toBe(false);
    expect(callCount).toBe(3);
    expect(tracker.lastOrdinal('10.0.0.3', 'ml0')).toBe(200);
  });

  it('resets stall timer when ordinal advances', async () => {
    const config = makeConfig();
    const tracker = new StallTracker();

    // Simulate old stall
    const oldTime = Date.now() - 10 * 60 * 1000;
    tracker.update('10.0.0.1', 'ml0', 100, oldTime);

    // New fetch returns advanced ordinal
    const mockFetch: OrdinalFetchFn = async () => 101;

    const result = await detectSnapshotsStopped(config, mockFetch, tracker);
    expect(result.detected).toBe(false);

    // Timer should be reset
    const staleSecs = tracker.staleSecs('10.0.0.1', 'ml0');
    expect(staleSecs).toBeLessThan(1);
  });

  it('uses default 4 minute threshold if not configured', async () => {
    const config = makeConfig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (config as any).snapshotStallMinutes;

    const tracker = new StallTracker();
    // Set stale for 3 minutes (under 4 minute threshold)
    tracker.update('10.0.0.1', 'ml0', 100, Date.now() - 3 * 60 * 1000);

    const mockFetch: OrdinalFetchFn = async () => 100;
    const result = await detectSnapshotsStopped(config, mockFetch, tracker);
    expect(result.detected).toBe(false);
  });
});
