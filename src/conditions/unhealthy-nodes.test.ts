/**
 * Unhealthy Node Detection Tests
 *
 * Tests for unhealthy node detection logic.
 */

import { describe, it, expect } from 'vitest';
import { detectUnhealthyNodesFromSnapshot } from './unhealthy-nodes.js';
import type { Config } from '../config.js';
import type { HealthSnapshot, LayerHealth, Layer } from '../types.js';

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

function makeSnapshot(
  nodeData: Array<{
    ip: string;
    name: string;
    layers: Array<{ layer: Layer; state: string; reachable: boolean }>;
  }>,
): HealthSnapshot {
  return {
    timestamp: new Date(),
    stale: false,
    source: 'redis',
    nodes: nodeData.map((n) => ({
      ip: n.ip,
      name: n.name,
      layers: n.layers.map((l) => ({
        layer: l.layer,
        state: l.state,
        ordinal: 100,
        reachable: l.reachable,
        clusterSize: 3,
      })),
    })),
  };
}

function healthyLayers(): Array<{ layer: Layer; state: string; reachable: boolean }> {
  return [
    { layer: 'gl0', state: 'Ready', reachable: true },
    { layer: 'ml0', state: 'Ready', reachable: true },
    { layer: 'cl1', state: 'Ready', reachable: true },
    { layer: 'dl1', state: 'Ready', reachable: true },
  ];
}

// ---------------------------------------------------------------------------
// detectUnhealthyNodesFromSnapshot tests
// ---------------------------------------------------------------------------

describe('detectUnhealthyNodesFromSnapshot()', () => {
  it('returns detected=false when all nodes healthy', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: healthyLayers() },
      { ip: '10.0.0.2', name: 'node2', layers: healthyLayers() },
      { ip: '10.0.0.3', name: 'node3', layers: healthyLayers() },
    ]);

    const result = detectUnhealthyNodesFromSnapshot(config, snapshot);
    expect(result.detected).toBe(false);
    expect(result.condition).toBe('UnhealthyNodes');
  });

  it('detects single unreachable node', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: healthyLayers() },
      { ip: '10.0.0.2', name: 'node2', layers: healthyLayers() },
      {
        ip: '10.0.0.3',
        name: 'node3',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'Unreachable', reachable: false },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
    ]);

    const result = detectUnhealthyNodesFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.restartScope).toBe('individual-node');
    expect(result.affectedNodes).toContain('10.0.0.3');
    expect(result.affectedLayers).toContain('ml0');
  });

  it('detects stuck state (WaitingForDownload)', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      { ip: '10.0.0.1', name: 'node1', layers: healthyLayers() },
      { ip: '10.0.0.2', name: 'node2', layers: healthyLayers() },
      {
        ip: '10.0.0.3',
        name: 'node3',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'WaitingForDownload', reachable: true },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
    ]);

    const result = detectUnhealthyNodesFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.affectedNodes).toContain('10.0.0.3');
  });

  it('recommends full-metagraph when GL0 fully down', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      {
        ip: '10.0.0.1',
        name: 'node1',
        layers: [
          { layer: 'gl0', state: 'Offline', reachable: false },
          { layer: 'ml0', state: 'Ready', reachable: true },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
      {
        ip: '10.0.0.2',
        name: 'node2',
        layers: [
          { layer: 'gl0', state: 'Offline', reachable: false },
          { layer: 'ml0', state: 'Ready', reachable: true },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
      {
        ip: '10.0.0.3',
        name: 'node3',
        layers: [
          { layer: 'gl0', state: 'Offline', reachable: false },
          { layer: 'ml0', state: 'Ready', reachable: true },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
    ]);

    const result = detectUnhealthyNodesFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.restartScope).toBe('full-metagraph');
    expect(result.details).toContain('GL0 fully down');
  });

  it('recommends full-metagraph when ML0 fully down', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      {
        ip: '10.0.0.1',
        name: 'node1',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'Offline', reachable: false },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
      {
        ip: '10.0.0.2',
        name: 'node2',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'Leaving', reachable: true },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
      {
        ip: '10.0.0.3',
        name: 'node3',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'WaitingForDownload', reachable: true },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
    ]);

    const result = detectUnhealthyNodesFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.restartScope).toBe('full-metagraph');
    expect(result.details).toContain('ML0 fully down');
  });

  it('recommends full-layer when CL1 fully down', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      {
        ip: '10.0.0.1',
        name: 'node1',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'Ready', reachable: true },
          { layer: 'cl1', state: 'Offline', reachable: false },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
      {
        ip: '10.0.0.2',
        name: 'node2',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'Ready', reachable: true },
          { layer: 'cl1', state: 'Offline', reachable: false },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
      {
        ip: '10.0.0.3',
        name: 'node3',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'Ready', reachable: true },
          { layer: 'cl1', state: 'Offline', reachable: false },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
    ]);

    const result = detectUnhealthyNodesFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.restartScope).toBe('full-layer');
    expect(result.affectedLayers).toEqual(['cl1']);
  });

  it('combines multiple unhealthy nodes in details', () => {
    const config = makeConfig(3);
    const snapshot = makeSnapshot([
      {
        ip: '10.0.0.1',
        name: 'node1',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'Offline', reachable: false },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Ready', reachable: true },
        ],
      },
      { ip: '10.0.0.2', name: 'node2', layers: healthyLayers() },
      {
        ip: '10.0.0.3',
        name: 'node3',
        layers: [
          { layer: 'gl0', state: 'Ready', reachable: true },
          { layer: 'ml0', state: 'Ready', reachable: true },
          { layer: 'cl1', state: 'Ready', reachable: true },
          { layer: 'dl1', state: 'Leaving', reachable: true },
        ],
      },
    ]);

    const result = detectUnhealthyNodesFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.restartScope).toBe('individual-node');
    expect(result.affectedNodes).toContain('10.0.0.1');
    expect(result.affectedNodes).toContain('10.0.0.3');
    expect(result.affectedLayers).toContain('ml0');
    expect(result.affectedLayers).toContain('dl1');
  });
});
