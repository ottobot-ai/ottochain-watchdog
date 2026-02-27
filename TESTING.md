# Testing Guide

## Philosophy

The watchdog uses **pure functions** for condition detection. This makes testing straightforward:

1. **Condition detectors** are pure functions that accept `HealthSnapshot` data and return `DetectionResult`
2. **No mocking required** for the core logic — just construct test data
3. **Integration with Redis/Postgres** is tested separately

## Test Structure

```
src/
├── conditions/
│   ├── forked-cluster.ts
│   ├── forked-cluster.test.ts
│   ├── snapshots-stopped.ts
│   ├── snapshots-stopped.test.ts
│   ├── unhealthy-nodes.ts
│   └── unhealthy-nodes.test.ts
└── services/
    └── health-reader.test.ts  (integration)
```

## Running Tests

```bash
# Run all tests
npm test

# Watch mode (re-run on changes)
npm run test:watch

# Run specific test file
npx vitest run src/conditions/forked-cluster.test.ts
```

## Writing Tests

### Testing Pure Function Condition Detectors

```typescript
import { describe, it, expect } from 'vitest';
import { detectForkedClusterFromSnapshot } from './forked-cluster.js';
import type { HealthSnapshot } from '../types.js';

describe('detectForkedClusterFromSnapshot', () => {
  it('detects fork when nodes have different cluster views', () => {
    const config = makeTestConfig(3);
    const snapshot: HealthSnapshot = {
      timestamp: new Date(),
      stale: false,
      source: 'redis',
      nodes: [
        {
          ip: '10.0.0.1',
          name: 'node1',
          layers: [
            { layer: 'ml0', state: 'Ready', ordinal: 100, reachable: true, clusterSize: 3, clusterHash: 'abc123' },
          ],
        },
        {
          ip: '10.0.0.2',
          name: 'node2',
          layers: [
            { layer: 'ml0', state: 'Ready', ordinal: 100, reachable: true, clusterSize: 3, clusterHash: 'abc123' },
          ],
        },
        {
          ip: '10.0.0.3',
          name: 'node3',
          layers: [
            // Different cluster hash — this node is forked
            { layer: 'ml0', state: 'Ready', ordinal: 100, reachable: true, clusterSize: 1, clusterHash: 'xyz789' },
          ],
        },
      ],
    };

    const result = detectForkedClusterFromSnapshot(config, snapshot);
    expect(result.detected).toBe(true);
    expect(result.condition).toBe('ForkedCluster');
    expect(result.affectedNodes).toContain('10.0.0.3');
  });
});
```

### Testing Stall Tracker

The `StallTracker` class tracks ordinal changes over time:

```typescript
import { StallTracker } from './snapshots-stopped.js';

describe('StallTracker', () => {
  it('detects stall when ordinal unchanged', () => {
    const tracker = new StallTracker();
    
    // First update establishes baseline
    tracker.update('node1', 'ml0', 100, Date.now() - 300_000); // 5 min ago
    
    // Second update with same ordinal
    const advanced = tracker.update('node1', 'ml0', 100);
    expect(advanced).toBe(false);
    
    // Check stale time
    const staleSecs = tracker.staleSecs('node1', 'ml0');
    expect(staleSecs).toBeGreaterThan(250); // ~5 minutes
  });
});
```

### Testing Health Reader (Integration)

Mock Redis for health reader tests:

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock ioredis
vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    get: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

describe('HealthReader', () => {
  it('uses Redis data when fresh', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        timestamp: new Date().toISOString(),
        nodes: [/* ... */],
      })),
    };
    
    // ... test health reader with mocked Redis
  });

  it('falls back to direct HTTP when Redis stale', async () => {
    const oldTimestamp = new Date(Date.now() - 120_000); // 2 min ago
    const mockRedis = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        timestamp: oldTimestamp.toISOString(),
        nodes: [],
      })),
    };
    
    // ... test that fallback is triggered
  });
});
```

## Test Helpers

### makeTestConfig

```typescript
function makeTestConfig(nodeCount: number = 3): Config {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      ip: `10.0.0.${i + 1}`,
      name: `node${i + 1}`,
    })),
    ports: { gl0: 9000, ml0: 9200, cl1: 9300, dl1: 9400 },
    cliPorts: { gl0: 9002, ml0: 9202, cl1: 9302, dl1: 9402 },
    p2pPorts: { gl0: 9001, ml0: 9201, cl1: 9301, dl1: 9401 },
    sshKeyPath: '/test/key',
    sshUser: 'test',
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
```

### makeHealthSnapshot

```typescript
function makeHealthSnapshot(
  nodes: Array<{ ip: string; layers: LayerHealth[] }>,
  source: 'redis' | 'direct' = 'redis',
): HealthSnapshot {
  return {
    timestamp: new Date(),
    stale: false,
    source,
    nodes: nodes.map((n, i) => ({
      ip: n.ip,
      name: `node${i + 1}`,
      layers: n.layers,
    })),
  };
}
```

## CI

Tests run in GitHub Actions on every push and PR:

```yaml
# .github/workflows/ci.yml
- name: Run tests
  run: npm test
```

Tests are configured with retry (see `vitest.config.ts`) to handle any flakiness from timing-sensitive tests.

## Coverage

To run with coverage:

```bash
npx vitest run --coverage
```

Focus coverage on condition detection logic — the SSH/restart orchestration is harder to unit test and is primarily validated through integration testing in staging environments.
