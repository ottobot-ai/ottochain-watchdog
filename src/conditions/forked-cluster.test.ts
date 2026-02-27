/**
 * Fork Detection Tests
 *
 * Tests for cluster fork detection logic.
 * Tests both the pure function (snapshot-based) and legacy (direct HTTP) modes.
 */

import { describe, it, expect } from 'vitest';
import {
  hashClusterPOV,
  findMajority,
  checkLayerFork,
  detectForkedCluster,
  checkLayerForkFromSnapshot,
  detectForkedClusterFromSnapshot,
  type NodePOV,
  type ClusterFetchFn,
} from './forked-cluster.js';
import type { Config } from '../config.js';
import type { ClusterMember, HealthSnapshot, LayerHealth } from '../types.js';

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

function makeMember(id: string, state = 'Ready'): ClusterMember {
  return { id, state };
}

function makeSnapshot(nodeLayerData: Array<{
  ip: string;
  name: string;
  layers: Array<{ layer: string; clusterHash?: string; reachable?: boolean }>;
}>): HealthSnapshot {
  return {
    timestamp: new Date(),
    stale: false,
    source: 'redis',
    nodes: nodeLayerData.map(n => ({
      ip: n.ip,
      name: n.name,
      layers: n.layers.map(l => ({
        layer: l.layer as LayerHealth['layer'],
        state: 'Ready',
        ordinal: 100,
        reachable: l.reachable ?? true,
        clusterSize: 3,
        clusterHash: l.clusterHash,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// hashClusterPOV tests
// ---------------------------------------------------------------------------

describe('hashClusterPOV()', () => {
  it('returns stable hash for sorted peer IDs', () => {
    const members = [makeMember('peer-c'), makeMember('peer-a'), makeMember('peer-b')];
    const hash1 = hashClusterPOV(members);
    const hash2 = hashClusterPOV([...members].reverse());
    expect(hash1).toBe(hash2); // Order independent
    expect(hash1).toHaveLength(12); // Truncated hex
  });

  it('returns different hash for different peers', () => {
    const hash1 = hashClusterPOV([makeMember('peer-a')]);
    const hash2 = hashClusterPOV([makeMember('peer-b')]);
    expect(hash1).not.toBe(hash2);
  });

  it('returns stable hash for empty members', () => {
    const hash = hashClusterPOV([]);
    expect(hash).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// findMajority tests
// ---------------------------------------------------------------------------

describe('findMajority()', () => {
  it('identifies correct majority when 2 of 3 nodes agree', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: 'abc123', reachable: true },
      { ip: '10.0.0.2', hash: 'abc123', reachable: true },
      { ip: '10.0.0.3', hash: 'xyz789', reachable: true }, // minority
    ];

    const result = findMajority(povs);
    expect(result.majorityHash).toBe('abc123');
    expect(result.majorityNodes.sort()).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(result.minorityNodes).toEqual(['10.0.0.3']);
    expect(result.unreachable).toEqual([]);
  });

  it('identifies unreachable nodes separately from minority', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: 'abc123', reachable: true },
      { ip: '10.0.0.2', hash: 'abc123', reachable: true },
      { ip: '10.0.0.3', hash: '', reachable: false, error: 'ECONNREFUSED' },
    ];

    const result = findMajority(povs);
    expect(result.majorityNodes.sort()).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(result.minorityNodes).toEqual([]);
    expect(result.unreachable).toEqual(['10.0.0.3']);
  });

  it('all nodes agree → no minority', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: 'same', reachable: true },
      { ip: '10.0.0.2', hash: 'same', reachable: true },
      { ip: '10.0.0.3', hash: 'same', reachable: true },
    ];

    const result = findMajority(povs);
    expect(result.minorityNodes).toEqual([]);
    expect(result.majorityNodes).toHaveLength(3);
  });

  it('all unreachable → empty majority', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: '', reachable: false, error: 'timeout' },
      { ip: '10.0.0.2', hash: '', reachable: false, error: 'timeout' },
      { ip: '10.0.0.3', hash: '', reachable: false, error: 'timeout' },
    ];

    const result = findMajority(povs);
    expect(result.majorityNodes).toEqual([]);
    expect(result.unreachable).toHaveLength(3);
  });

  it('handles tie by picking first seen', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: 'aaa', reachable: true },
      { ip: '10.0.0.2', hash: 'bbb', reachable: true },
    ];

    const result = findMajority(povs);
    // One will be majority, one minority
    expect(result.majorityNodes.length + result.minorityNodes.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkLayerForkFromSnapshot tests (pure function)
// ---------------------------------------------------------------------------

describe('checkLayerForkFromSnapshot()', () => {
  it('detects fork when one node has different hash', () => {
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: [{ layer: 'ml0', clusterHash: 'abc123' }] },
      { ip: '10.0.0.2', name: 'node2', layers: [{ layer: 'ml0', clusterHash: 'abc123' }] },
      { ip: '10.0.0.3', name: 'node3', layers: [{ layer: 'ml0', clusterHash: 'xyz789' }] },
    ]);

    const result = checkLayerForkFromSnapshot(snapshot, 'ml0');
    expect(result.forked).toBe(true);
    expect(result.minorityNodes).toContain('10.0.0.3');
  });

  it('no fork when all nodes agree', () => {
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: [{ layer: 'ml0', clusterHash: 'same' }] },
      { ip: '10.0.0.2', name: 'node2', layers: [{ layer: 'ml0', clusterHash: 'same' }] },
      { ip: '10.0.0.3', name: 'node3', layers: [{ layer: 'ml0', clusterHash: 'same' }] },
    ]);

    const result = checkLayerForkFromSnapshot(snapshot, 'ml0');
    expect(result.forked).toBe(false);
  });

  it('handles unreachable nodes', () => {
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: [{ layer: 'ml0', clusterHash: 'abc', reachable: true }] },
      { ip: '10.0.0.2', name: 'node2', layers: [{ layer: 'ml0', clusterHash: 'abc', reachable: true }] },
      { ip: '10.0.0.3', name: 'node3', layers: [{ layer: 'ml0', reachable: false }] },
    ]);

    const result = checkLayerForkFromSnapshot(snapshot, 'ml0');
    expect(result.forked).toBe(false);
    expect(result.unreachable).toContain('10.0.0.3');
  });
});

// ---------------------------------------------------------------------------
// detectForkedClusterFromSnapshot tests (pure function)
// ---------------------------------------------------------------------------

describe('detectForkedClusterFromSnapshot()', () => {
  it('returns detected=false when no forks', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: [
        { layer: 'ml0', clusterHash: 'same' },
        { layer: 'cl1', clusterHash: 'same' },
        { layer: 'dl1', clusterHash: 'same' },
      ]},
      { ip: '10.0.0.2', name: 'node2', layers: [
        { layer: 'ml0', clusterHash: 'same' },
        { layer: 'cl1', clusterHash: 'same' },
        { layer: 'dl1', clusterHash: 'same' },
      ]},
      { ip: '10.0.0.3', name: 'node3', layers: [
        { layer: 'ml0', clusterHash: 'same' },
        { layer: 'cl1', clusterHash: 'same' },
        { layer: 'dl1', clusterHash: 'same' },
      ]},
    ]);

    const result = detectForkedClusterFromSnapshot(config, snapshot);
    expect(result.detected).toBe(false);
    expect(result.condition).toBe('ForkedCluster');
  });

  it('returns detected=true with affected layer on fork', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: [
        { layer: 'ml0', clusterHash: 'same' },
        { layer: 'cl1', clusterHash: 'same' },
        { layer: 'dl1', clusterHash: 'same' },
      ]},
      { ip: '10.0.0.2', name: 'node2', layers: [
        { layer: 'ml0', clusterHash: 'same' },
        { layer: 'cl1', clusterHash: 'same' },
        { layer: 'dl1', clusterHash: 'same' },
      ]},
      { ip: '10.0.0.3', name: 'node3', layers: [
        { layer: 'ml0', clusterHash: 'same' },
        { layer: 'cl1', clusterHash: 'same' },
        { layer: 'dl1', clusterHash: 'different' }, // Fork on DL1
      ]},
    ]);

    const result = detectForkedClusterFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.affectedLayers).toContain('dl1');
    expect(result.affectedNodes).toContain('10.0.0.3');
  });

  it('recommends individual-node restart for single minority', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: [{ layer: 'ml0', clusterHash: 'same' }] },
      { ip: '10.0.0.2', name: 'node2', layers: [{ layer: 'ml0', clusterHash: 'same' }] },
      { ip: '10.0.0.3', name: 'node3', layers: [{ layer: 'ml0', clusterHash: 'different' }] },
    ]);

    const result = detectForkedClusterFromSnapshot(config, snapshot);
    expect(result.restartScope).toBe('individual-node');
  });

  it('recommends full-layer restart when majority forked', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: [{ layer: 'ml0', clusterHash: 'a' }] },
      { ip: '10.0.0.2', name: 'node2', layers: [{ layer: 'ml0', clusterHash: 'b' }] },
      { ip: '10.0.0.3', name: 'node3', layers: [{ layer: 'ml0', clusterHash: 'c' }] },
    ]);

    const result = detectForkedClusterFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.restartScope).toBe('full-layer');
  });
});

// ---------------------------------------------------------------------------
// Legacy direct HTTP tests
// ---------------------------------------------------------------------------

describe('checkLayerFork() [legacy]', () => {
  it('detects fork when one node disagrees', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async (ip) => {
      if (ip === '10.0.0.3') {
        return [makeMember('different-peer')];
      }
      return [makeMember('peer-a'), makeMember('peer-b')];
    };

    const result = await checkLayerFork(config, 'ml0', mockFetch);
    expect(result.forked).toBe(true);
    expect(result.minorityNodes).toContain('10.0.0.3');
  });

  it('no fork when all nodes agree', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async () => [makeMember('peer-a')];

    const result = await checkLayerFork(config, 'ml0', mockFetch);
    expect(result.forked).toBe(false);
    expect(result.minorityNodes).toEqual([]);
  });
});

describe('detectForkedCluster() [legacy]', () => {
  it('returns detected=false when no forks', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async () => [makeMember('peer-a')];

    const result = await detectForkedCluster(config, mockFetch);
    expect(result.detected).toBe(false);
    expect(result.condition).toBe('ForkedCluster');
  });

  it('checks layers in order: ml0, cl1, dl1', async () => {
    const config = makeConfig(3);
    const layersSeen: number[] = [];
    const mockFetch: ClusterFetchFn = async (_, port) => {
      layersSeen.push(port);
      return [makeMember('same')];
    };

    await detectForkedCluster(config, mockFetch);
    expect(layersSeen).toEqual([9200, 9200, 9200, 9300, 9300, 9300, 9400, 9400, 9400]);
  });
});
