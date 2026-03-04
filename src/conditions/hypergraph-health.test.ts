/**
 * Hypergraph Health Detection Tests
 */

import { describe, it, expect } from 'vitest';
import { detectHypergraphHealth, type HypergraphHealthDeps } from './hypergraph-health.js';
import type { Config, HypergraphConfig } from '../config.js';
import type { HealthSnapshot, LayerHealth, NodeInfo, ClusterMember } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(opts?: { hypergraph?: Partial<HypergraphConfig> }): Config {
  return {
    nodes: [
      { ip: '10.0.0.1', name: 'node1' },
      { ip: '10.0.0.2', name: 'node2' },
      { ip: '10.0.0.3', name: 'node3' },
    ],
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
    managedLayers: ['ml0', 'dl1'],
    maxConsecutiveFailures: 3,
    hypergraph: opts?.hypergraph ? {
      enabled: true,
      l0Urls: ['http://hypergraph-l0:9000'],
      checkIntervalMultiplier: 3,
      ...opts.hypergraph,
    } : undefined,
  };
}

function makeSnapshot(gl0ClusterSize: number = 10): HealthSnapshot {
  return {
    timestamp: new Date(),
    stale: false,
    source: 'redis',
    nodes: [
      {
        ip: '10.0.0.1', name: 'node1',
        layers: [{ layer: 'gl0' as const, state: 'Ready', ordinal: 100, reachable: true, clusterSize: gl0ClusterSize }],
      },
      {
        ip: '10.0.0.2', name: 'node2',
        layers: [{ layer: 'gl0' as const, state: 'Ready', ordinal: 100, reachable: true, clusterSize: gl0ClusterSize }],
      },
      {
        ip: '10.0.0.3', name: 'node3',
        layers: [{ layer: 'gl0' as const, state: 'Ready', ordinal: 100, reachable: true, clusterSize: gl0ClusterSize }],
      },
    ],
  };
}

function makeNodeInfo(): NodeInfo {
  return { state: 'Ready', id: 'hg-node-1', host: '1.2.3.4', publicPort: 9000, p2pPort: 9001 };
}

function makeClusterMembers(count: number): ClusterMember[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `peer-${i}`,
    state: 'Ready',
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectHypergraphHealth()', () => {
  it('skips when hypergraph is not configured', async () => {
    const config = makeConfig(); // no hypergraph config
    const snapshot = makeSnapshot();

    const result = await detectHypergraphHealth(config, snapshot);
    expect(result.detected).toBe(false);
    expect(result.condition).toBe('HypergraphHealth');
  });

  it('skips when hypergraph is disabled', async () => {
    const config = makeConfig({ hypergraph: { enabled: false } });
    const snapshot = makeSnapshot();

    const result = await detectHypergraphHealth(config, snapshot);
    expect(result.detected).toBe(false);
  });

  it('detects when all L0 URLs are unreachable', async () => {
    const config = makeConfig({
      hypergraph: { l0Urls: ['http://hg1:9000', 'http://hg2:9000'] },
    });
    const snapshot = makeSnapshot();
    const deps: HypergraphHealthDeps = {
      checkL0: async () => null, // all fail
    };

    const result = await detectHypergraphHealth(config, snapshot, deps);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('unreachable');
    expect(result.restartScope).toBe('none');
  });

  it('no detection when hypergraph is reachable and GL0 connected', async () => {
    const config = makeConfig({ hypergraph: {} });
    const snapshot = makeSnapshot(10); // cluster size 10 > our 3 nodes
    const deps: HypergraphHealthDeps = {
      checkL0: async () => makeNodeInfo(),
      getCluster: async () => makeClusterMembers(50),
    };

    const result = await detectHypergraphHealth(config, snapshot, deps);
    expect(result.detected).toBe(false);
  });

  it('detects GL0 disconnected when cluster size equals our node count', async () => {
    const config = makeConfig({ hypergraph: {} });
    const snapshot = makeSnapshot(3); // cluster size 3 === our 3 nodes → disconnected
    const deps: HypergraphHealthDeps = {
      checkL0: async () => makeNodeInfo(),
      getCluster: async () => makeClusterMembers(50),
    };

    const result = await detectHypergraphHealth(config, snapshot, deps);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('disconnected');
    expect(result.restartScope).toBe('none');
  });

  it('detects GL0 disconnected when cluster size is less than our node count', async () => {
    const config = makeConfig({ hypergraph: {} });
    const snapshot = makeSnapshot(2); // only 2 peers, we have 3 nodes
    const deps: HypergraphHealthDeps = {
      checkL0: async () => makeNodeInfo(),
      getCluster: async () => makeClusterMembers(50),
    };

    const result = await detectHypergraphHealth(config, snapshot, deps);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('disconnected');
  });

  it('no detection when GL0 nodes are all unreachable (handled by other conditions)', async () => {
    const config = makeConfig({ hypergraph: {} });
    const snapshot: HealthSnapshot = {
      timestamp: new Date(),
      stale: false,
      source: 'redis',
      nodes: [
        { ip: '10.0.0.1', name: 'node1', layers: [{ layer: 'gl0' as const, state: 'Unreachable', ordinal: 0, reachable: false, clusterSize: 0 }] },
        { ip: '10.0.0.2', name: 'node2', layers: [{ layer: 'gl0' as const, state: 'Unreachable', ordinal: 0, reachable: false, clusterSize: 0 }] },
        { ip: '10.0.0.3', name: 'node3', layers: [{ layer: 'gl0' as const, state: 'Unreachable', ordinal: 0, reachable: false, clusterSize: 0 }] },
      ],
    };
    const deps: HypergraphHealthDeps = {
      checkL0: async () => makeNodeInfo(),
      getCluster: async () => makeClusterMembers(50),
    };

    const result = await detectHypergraphHealth(config, snapshot, deps);
    expect(result.detected).toBe(false);
  });

  it('tries multiple L0 URLs and succeeds on second', async () => {
    const config = makeConfig({
      hypergraph: { l0Urls: ['http://hg1:9000', 'http://hg2:9000'] },
    });
    const snapshot = makeSnapshot(10);
    let callCount = 0;
    const deps: HypergraphHealthDeps = {
      checkL0: async () => {
        callCount++;
        return callCount === 1 ? null : makeNodeInfo(); // first fails, second succeeds
      },
      getCluster: async () => makeClusterMembers(50),
    };

    const result = await detectHypergraphHealth(config, snapshot, deps);
    expect(result.detected).toBe(false);
    expect(callCount).toBe(2);
  });
});
