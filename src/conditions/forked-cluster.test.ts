/**
 * Fork Detection Tests
 *
 * Tests for cluster fork detection logic.
 * Ported from PR #4 (packages/health-monitor/test/cluster.test.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  hashClusterPOV,
  findMajority,
  checkLayerFork,
  detectForkedCluster,
  type NodePOV,
  type ClusterFetchFn,
} from './forked-cluster.js';
import type { Config } from '../config.js';
import type { ClusterMember } from '../types.js';

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
    daemon: false,
    once: false,
  };
}

function makeMember(id: string, state = 'Ready'): ClusterMember {
  return { id, state };
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
      { ip: '10.0.0.1', hash: 'abc123', members: [makeMember('p1')] },
      { ip: '10.0.0.2', hash: 'abc123', members: [makeMember('p1')] },
      { ip: '10.0.0.3', hash: 'xyz789', members: [makeMember('p2')] }, // minority
    ];

    const result = findMajority(povs);
    expect(result.majorityHash).toBe('abc123');
    expect(result.majorityNodes.sort()).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(result.minorityNodes).toEqual(['10.0.0.3']);
    expect(result.unreachable).toEqual([]);
  });

  it('identifies unreachable nodes separately from minority', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: 'abc123', members: [makeMember('p1')] },
      { ip: '10.0.0.2', hash: 'abc123', members: [makeMember('p1')] },
      { ip: '10.0.0.3', hash: '', members: [], error: 'ECONNREFUSED' },
    ];

    const result = findMajority(povs);
    expect(result.majorityNodes.sort()).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(result.minorityNodes).toEqual([]);
    expect(result.unreachable).toEqual(['10.0.0.3']);
  });

  it('all nodes agree → no minority', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: 'same', members: [] },
      { ip: '10.0.0.2', hash: 'same', members: [] },
      { ip: '10.0.0.3', hash: 'same', members: [] },
    ];

    const result = findMajority(povs);
    expect(result.minorityNodes).toEqual([]);
    expect(result.majorityNodes).toHaveLength(3);
  });

  it('all unreachable → empty majority', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: '', members: [], error: 'timeout' },
      { ip: '10.0.0.2', hash: '', members: [], error: 'timeout' },
      { ip: '10.0.0.3', hash: '', members: [], error: 'timeout' },
    ];

    const result = findMajority(povs);
    expect(result.majorityNodes).toEqual([]);
    expect(result.unreachable).toHaveLength(3);
  });

  it('handles tie by picking first seen', () => {
    const povs: NodePOV[] = [
      { ip: '10.0.0.1', hash: 'aaa', members: [] },
      { ip: '10.0.0.2', hash: 'bbb', members: [] },
    ];

    const result = findMajority(povs);
    // One will be majority, one minority
    expect(result.majorityNodes.length + result.minorityNodes.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkLayerFork tests
// ---------------------------------------------------------------------------

describe('checkLayerFork()', () => {
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

  it('handles unreachable nodes gracefully', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async (ip) => {
      if (ip === '10.0.0.3') throw new Error('ECONNREFUSED');
      return [makeMember('peer-a')];
    };

    const result = await checkLayerFork(config, 'ml0', mockFetch);
    expect(result.forked).toBe(false); // Unreachable != minority
    expect(result.unreachable).toContain('10.0.0.3');
  });

  it('treats empty cluster as potential divergence', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async (ip) => {
      if (ip === '10.0.0.3') return []; // Empty
      return [makeMember('peer-a')];
    };

    const result = await checkLayerFork(config, 'ml0', mockFetch);
    expect(result.forked).toBe(true);
    expect(result.minorityNodes).toContain('10.0.0.3');
  });
});

// ---------------------------------------------------------------------------
// detectForkedCluster tests
// ---------------------------------------------------------------------------

describe('detectForkedCluster()', () => {
  it('returns detected=false when no forks', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async () => [makeMember('peer-a')];

    const result = await detectForkedCluster(config, mockFetch);
    expect(result.detected).toBe(false);
    expect(result.condition).toBe('ForkedCluster');
  });

  it('returns detected=true with affected layer on fork', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async (ip, port) => {
      // Fork only on DL1 (port 9400)
      if (port === 9400 && ip === '10.0.0.3') {
        return [makeMember('different')];
      }
      return [makeMember('same')];
    };

    const result = await detectForkedCluster(config, mockFetch);
    expect(result.detected).toBe(true);
    expect(result.affectedLayers).toContain('dl1');
    expect(result.affectedNodes).toContain('10.0.0.3');
  });

  it('recommends individual-node restart for single minority', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async (ip) => {
      if (ip === '10.0.0.3') return [makeMember('different')];
      return [makeMember('same')];
    };

    const result = await detectForkedCluster(config, mockFetch);
    expect(result.restartScope).toBe('individual-node');
  });

  it('recommends full-layer restart when majority forked', async () => {
    const config = makeConfig(3);
    const mockFetch: ClusterFetchFn = async (ip) => {
      // Each node sees different cluster
      return [makeMember(`unique-${ip}`)];
    };

    const result = await detectForkedCluster(config, mockFetch);
    expect(result.detected).toBe(true);
    expect(result.restartScope).toBe('full-layer');
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
