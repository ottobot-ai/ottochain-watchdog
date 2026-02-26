/**
 * Tessellation Alert Rule Tests (Failing — TDD)
 *
 * Spec: docs/stability-alert-rules-restart-sop.md
 * Card: 📜 Stability: Tessellation log analysis for error patterns (69962fd9fd)
 *
 * These tests are EXPECTED TO FAIL until the implementation in tessellation-alerts.ts
 * is completed. They define the acceptance criteria for all 4 alert rule types.
 *
 * Implementation tracked by Trello card 69962fd9fd → In Development
 */

import { describe, it, expect } from 'vitest';
import {
  checkML0ZeroUpdates,
  checkDL1DownloadOnly,
  checkGL0PeerDrop,
  checkCL1ContainerDown,
  isBenignEmberError,
  type ML0SnapshotLogEntry,
  type DL1LogEvent,
} from './tessellation-alerts.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeML0Entries(counts: number[]): ML0SnapshotLogEntry[] {
  const now = new Date();
  return counts.map((updateCount, i) => ({
    timestamp: new Date(now.getTime() - (counts.length - 1 - i) * 5000), // 5s apart
    updateCount,
  }));
}

function makeDL1Events(types: Array<'DownloadPerformed' | 'RoundFinished' | 'BlockProduced'>): DL1LogEvent[] {
  const now = new Date();
  return types.map((eventType, i) => ({
    timestamp: new Date(now.getTime() - (types.length - 1 - i) * 30000), // 30s apart
    eventType,
  }));
}

// ---------------------------------------------------------------------------
// Alert Rule 1: ML0 Zero-Updates
// ---------------------------------------------------------------------------

describe('checkML0ZeroUpdates', () => {
  it('returns null when all snapshots have updates', () => {
    const entries = makeML0Entries([5, 3, 8, 2, 6]);
    const result = checkML0ZeroUpdates('10.0.0.1', entries);
    expect(result).toBeNull();
  });

  it('returns null when fewer than threshold consecutive zero-update snapshots', () => {
    // 2 consecutive zeros — below default threshold of 3
    const entries = makeML0Entries([5, 3, 0, 0, 5]);
    const result = checkML0ZeroUpdates('10.0.0.1', entries);
    expect(result).toBeNull();
  });

  it('returns null when sporadic zeros are mixed with non-zero snapshots', () => {
    const entries = makeML0Entries([5, 0, 3, 0, 8]);
    const result = checkML0ZeroUpdates('10.0.0.1', entries);
    expect(result).toBeNull();
  });

  it('fires CRITICAL alert when exactly 3 consecutive zero-update snapshots', () => {
    const entries = makeML0Entries([5, 3, 0, 0, 0]);
    const result = checkML0ZeroUpdates('10.0.0.1', entries);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('ml0-zero-updates');
    expect(result!.severity).toBe('critical');
    expect(result!.nodeIp).toBe('10.0.0.1');
  });

  it('fires CRITICAL alert when more than 3 consecutive zeros', () => {
    const entries = makeML0Entries([0, 0, 0, 0, 0]);
    const result = checkML0ZeroUpdates('10.0.0.1', entries);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('alert details include consecutive count', () => {
    const entries = makeML0Entries([5, 0, 0, 0, 0]);
    const result = checkML0ZeroUpdates('10.0.0.1', entries);
    expect(result).not.toBeNull();
    expect(result!.details).toHaveProperty('consecutiveZeroUpdates');
    expect(result!.details.consecutiveZeroUpdates).toBeGreaterThanOrEqual(4);
  });

  it('alert message mentions DL1 pipeline', () => {
    const entries = makeML0Entries([0, 0, 0, 0]);
    const result = checkML0ZeroUpdates('10.0.0.1', entries);
    expect(result).not.toBeNull();
    expect(result!.message.toLowerCase()).toMatch(/dl1|pipeline|0 updates/i);
  });

  it('respects custom threshold parameter', () => {
    // Only 2 consecutive zeros, but threshold is set to 2
    const entries = makeML0Entries([5, 3, 0, 0]);
    const resultDefault = checkML0ZeroUpdates('10.0.0.1', entries, 3);
    const resultCustom  = checkML0ZeroUpdates('10.0.0.1', entries, 2);
    expect(resultDefault).toBeNull();
    expect(resultCustom).not.toBeNull();
  });

  it('returns null when entries array is empty', () => {
    const result = checkML0ZeroUpdates('10.0.0.1', []);
    expect(result).toBeNull();
  });

  it('returns null when there are fewer entries than threshold', () => {
    const entries = makeML0Entries([0, 0]); // only 2, threshold = 3
    const result = checkML0ZeroUpdates('10.0.0.1', entries);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Alert Rule 2: DL1 Download-Only
// ---------------------------------------------------------------------------

describe('checkDL1DownloadOnly', () => {
  it('returns null when DL1 is producing blocks normally', () => {
    const events = makeDL1Events([
      'DownloadPerformed', 'RoundFinished',
      'DownloadPerformed', 'RoundFinished',
      'DownloadPerformed', 'RoundFinished',
    ]);
    const result = checkDL1DownloadOnly('10.0.0.1', events);
    expect(result).toBeNull();
  });

  it('returns null when fewer than 5 consecutive downloads without RoundFinished', () => {
    const events = makeDL1Events([
      'DownloadPerformed', 'DownloadPerformed',
      'DownloadPerformed', 'DownloadPerformed',
      'RoundFinished',
    ]);
    const result = checkDL1DownloadOnly('10.0.0.1', events);
    expect(result).toBeNull();
  });

  it('fires CRITICAL alert when 5+ consecutive DownloadPerformed with no RoundFinished', () => {
    const events = makeDL1Events([
      'DownloadPerformed', 'DownloadPerformed', 'DownloadPerformed',
      'DownloadPerformed', 'DownloadPerformed',
    ]);
    const result = checkDL1DownloadOnly('10.0.0.1', events);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('dl1-download-only');
    expect(result!.severity).toBe('critical');
    expect(result!.nodeIp).toBe('10.0.0.1');
  });

  it('alert details include download count', () => {
    const events = makeDL1Events([
      'DownloadPerformed', 'DownloadPerformed', 'DownloadPerformed',
      'DownloadPerformed', 'DownloadPerformed', 'DownloadPerformed',
    ]);
    const result = checkDL1DownloadOnly('10.0.0.1', events);
    expect(result).not.toBeNull();
    expect(result!.details).toHaveProperty('consecutiveDownloads');
    expect(result!.details.consecutiveDownloads).toBeGreaterThanOrEqual(5);
  });

  it('alert message mentions peer count or DL1 degraded mode', () => {
    const events = makeDL1Events(Array(5).fill('DownloadPerformed'));
    const result = checkDL1DownloadOnly('10.0.0.1', events);
    expect(result).not.toBeNull();
    expect(result!.message.toLowerCase()).toMatch(/peer|download|degraded|follower/i);
  });

  it('respects custom threshold parameter', () => {
    const events = makeDL1Events([
      'DownloadPerformed', 'DownloadPerformed', 'DownloadPerformed',
    ]);
    const resultDefault = checkDL1DownloadOnly('10.0.0.1', events, 5);
    const resultCustom  = checkDL1DownloadOnly('10.0.0.1', events, 3);
    expect(resultDefault).toBeNull();
    expect(resultCustom).not.toBeNull();
  });

  it('returns null when events array is empty', () => {
    const result = checkDL1DownloadOnly('10.0.0.1', []);
    expect(result).toBeNull();
  });

  it('treats RoundFinished AFTER downloads as recovery — no alert', () => {
    const events = makeDL1Events([
      'DownloadPerformed', 'DownloadPerformed', 'DownloadPerformed',
      'DownloadPerformed', 'DownloadPerformed', 'RoundFinished',
    ]);
    // 5 downloads, but a RoundFinished appears at end — still alert because
    // consecutive window before RoundFinished was ≥5
    // This edge case: implementation may differ, but test documents expected behavior:
    // The window BEFORE RoundFinished had 5 consecutive downloads → alert fires
    const result = checkDL1DownloadOnly('10.0.0.1', events);
    // Implementation decision: alert fires based on the window of 5 consecutive downloads
    // that occurred even if RoundFinished came after. Tests document this expectation.
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Alert Rule 3: GL0 Peer Count Drop
// ---------------------------------------------------------------------------

describe('checkGL0PeerDrop', () => {
  it('returns null when GL0 has 2 peers (healthy 3-node cluster)', () => {
    const result = checkGL0PeerDrop('10.0.0.1', 2);
    expect(result).toBeNull();
  });

  it('returns null when GL0 has 1 peer (valid 2-node majority cluster)', () => {
    // nodes2+3 each have peerCount=1 in a 2-node cluster — this is valid
    const result = checkGL0PeerDrop('10.0.0.2', 1);
    expect(result).toBeNull();
  });

  it('fires CRITICAL alert when GL0 has 0 peers (isolated)', () => {
    const result = checkGL0PeerDrop('10.0.0.1', 0);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('gl0-peer-drop');
    expect(result!.severity).toBe('critical');
    expect(result!.nodeIp).toBe('10.0.0.1');
  });

  it('alert details include peer count', () => {
    const result = checkGL0PeerDrop('10.0.0.1', 0);
    expect(result).not.toBeNull();
    expect(result!.details).toHaveProperty('peerCount', 0);
  });

  it('alert message mentions split-brain or isolation', () => {
    const result = checkGL0PeerDrop('10.0.0.1', 0);
    expect(result).not.toBeNull();
    expect(result!.message.toLowerCase()).toMatch(/isolated|split.brain|peer|solo/i);
  });

  it('fires for each of the 3 node IPs independently', () => {
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    for (const ip of ips) {
      const result = checkGL0PeerDrop(ip, 0);
      expect(result).not.toBeNull();
      expect(result!.nodeIp).toBe(ip);
    }
  });
});

// ---------------------------------------------------------------------------
// Alert Rule 4: CL1 Container Down
// ---------------------------------------------------------------------------

describe('checkCL1ContainerDown', () => {
  it('returns null when CL1 container is running', () => {
    const result = checkCL1ContainerDown('10.0.0.1', true);
    expect(result).toBeNull();
  });

  it('fires WARNING alert when CL1 container is not running', () => {
    const result = checkCL1ContainerDown('10.0.0.1', false);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('cl1-container-down');
    expect(result!.severity).toBe('warning');
    expect(result!.nodeIp).toBe('10.0.0.1');
  });

  it('alert details include container status', () => {
    const result = checkCL1ContainerDown('10.0.0.1', false);
    expect(result).not.toBeNull();
    expect(result!.details).toHaveProperty('isRunning', false);
  });

  it('alert message mentions CL1 or consensus layer', () => {
    const result = checkCL1ContainerDown('10.0.0.1', false);
    expect(result).not.toBeNull();
    expect(result!.message.toLowerCase()).toMatch(/cl1|consensus/i);
  });

  it('fires for each node independently when all CL1 are down (known P0)', () => {
    const nodes = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    for (const ip of nodes) {
      const result = checkCL1ContainerDown(ip, false);
      expect(result).not.toBeNull();
      expect(result!.nodeIp).toBe(ip);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-actionable patterns (Benign Ember errors should be ignored)
// ---------------------------------------------------------------------------

describe('isBenignEmberError', () => {
  it('returns true for EmberServerBuilderCompanionPlatform error line', () => {
    const line = '2026-02-22 03:12:41,543 ERROR [cats-effect-17] o.h.e.s.EmberServerBuilderCompanionPlatform - Request handler failed with HttpVersionNotSupported';
    expect(isBenignEmberError(line)).toBe(true);
  });

  it('returns true for short form Ember error', () => {
    const line = 'EmberServerBuilderCompanionPlatform - Request handler failed';
    expect(isBenignEmberError(line)).toBe(true);
  });

  it('returns false for consensus failure log line', () => {
    const line = 'ERROR ConsensusManager - Consensus round failed: timeout';
    expect(isBenignEmberError(line)).toBe(false);
  });

  it('returns false for GL0 peer drop log line', () => {
    const line = 'INFO ClusterService - Peers: 0';
    expect(isBenignEmberError(line)).toBe(false);
  });

  it('returns false for ML0 zero-updates log line', () => {
    const line = 'INFO SnapshotProcessor - Got 0 updates from DL1';
    expect(isBenignEmberError(line)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isBenignEmberError('')).toBe(false);
  });

  it('returns false for DL1 download-only pattern', () => {
    const line = 'INFO DownloadService - DownloadPerformed ordinal=6203';
    expect(isBenignEmberError(line)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alert structure completeness
// ---------------------------------------------------------------------------

describe('TessellationAlert structure', () => {
  it('all alert functions return alerts with required fields', () => {
    const alerts = [
      checkML0ZeroUpdates('10.0.0.1', makeML0Entries([0, 0, 0, 0])),
      checkDL1DownloadOnly('10.0.0.1', makeDL1Events(Array(5).fill('DownloadPerformed'))),
      checkGL0PeerDrop('10.0.0.1', 0),
      checkCL1ContainerDown('10.0.0.1', false),
    ];

    for (const alert of alerts) {
      expect(alert).not.toBeNull();
      expect(alert).toHaveProperty('nodeIp');
      expect(alert).toHaveProperty('ruleId');
      expect(alert).toHaveProperty('severity');
      expect(alert).toHaveProperty('message');
      expect(alert).toHaveProperty('details');
      expect(typeof alert!.message).toBe('string');
      expect(alert!.message.length).toBeGreaterThan(5);
    }
  });
});
