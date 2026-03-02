/**
 * Services Health Detection Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectServicesHealth } from './services-health.js';

// Mock SSH
vi.mock('../services/ssh.js', () => ({
  sshExec: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

import { sshExec } from '../services/ssh.js';

const mockSsh = vi.mocked(sshExec);

const baseConfig = {
  nodes: [{ name: 'node1', ip: '10.0.0.1' }],
  servicesNode: { name: 'services', ip: '10.0.0.4' },
  sshKeyPath: '/tmp/key',
  sshUser: 'root',
  ports: { gl0: 9000, ml0: 9200, cl1: 9300, dl1: 9400 },
  cliPorts: { gl0: 9002, ml0: 9202, cl1: 9302, dl1: 9402 },
  p2pPorts: { gl0: 9001, ml0: 9201, cl1: 9301, dl1: 9401 },
  snapshotStallMinutes: 4,
  healthCheckIntervalSeconds: 60,
  restartCooldownMinutes: 10,
  maxRestartsPerHour: 6,
  redisUrl: 'redis://localhost:6379',
  postgresUrl: 'postgresql://localhost:5432/test',
  healthDataStaleSeconds: 60,
  daemon: false,
  once: false,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectServicesHealth()', () => {
  it('returns not-detected when no services node configured', async () => {
    const config = { ...baseConfig, servicesNode: undefined };
    const result = await detectServicesHealth(config);
    expect(result.detected).toBe(false);
  });

  it('returns not-detected when all required containers are healthy', async () => {
    const dockerOutput = [
      'bridge|Up 2 hours (healthy)',
      'indexer|Up 2 hours (healthy)',
      'explorer|Up 2 hours (healthy)',
      'gateway|Up 2 hours (healthy)',
      'postgres|Up 2 hours',
      'redis|Up 2 hours',
    ].join('\n');

    mockSsh.mockResolvedValueOnce({ stdout: dockerOutput, stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '45%\n', stderr: '', code: 0 });  // disk
    mockSsh.mockResolvedValueOnce({ stdout: '60', stderr: '', code: 0 });    // memory

    const result = await detectServicesHealth(baseConfig);
    expect(result.detected).toBe(false);
  });

  it('detects missing required container', async () => {
    const dockerOutput = [
      'indexer|Up 2 hours (healthy)',
      'explorer|Up 2 hours (healthy)',
      'gateway|Up 2 hours (healthy)',
      'postgres|Up 2 hours',
      'redis|Up 2 hours',
      // bridge missing
    ].join('\n');

    mockSsh.mockResolvedValueOnce({ stdout: dockerOutput, stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '45%\n', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '60', stderr: '', code: 0 });

    const result = await detectServicesHealth(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('bridge: MISSING');
    expect(result.restartScope).toBe('none');
  });

  it('detects stopped required container', async () => {
    const dockerOutput = [
      'bridge|Exited (1) 5 minutes ago',
      'indexer|Up 2 hours (healthy)',
      'explorer|Up 2 hours (healthy)',
      'gateway|Up 2 hours (healthy)',
      'postgres|Up 2 hours',
      'redis|Up 2 hours',
    ].join('\n');

    mockSsh.mockResolvedValueOnce({ stdout: dockerOutput, stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '45%\n', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '60', stderr: '', code: 0 });

    const result = await detectServicesHealth(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('bridge: STOPPED');
  });

  it('detects unhealthy required container', async () => {
    const dockerOutput = [
      'bridge|Up 2 hours (unhealthy)',
      'indexer|Up 2 hours (healthy)',
      'explorer|Up 2 hours (healthy)',
      'gateway|Up 2 hours (healthy)',
      'postgres|Up 2 hours',
      'redis|Up 2 hours',
    ].join('\n');

    mockSsh.mockResolvedValueOnce({ stdout: dockerOutput, stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '45%\n', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '60', stderr: '', code: 0 });

    const result = await detectServicesHealth(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('bridge: UNHEALTHY');
  });

  it('detects high disk usage', async () => {
    const dockerOutput = [
      'bridge|Up 2 hours (healthy)',
      'indexer|Up 2 hours (healthy)',
      'explorer|Up 2 hours (healthy)',
      'gateway|Up 2 hours (healthy)',
      'postgres|Up 2 hours',
      'redis|Up 2 hours',
    ].join('\n');

    mockSsh.mockResolvedValueOnce({ stdout: dockerOutput, stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '92%\n', stderr: '', code: 0 });  // high disk
    mockSsh.mockResolvedValueOnce({ stdout: '60', stderr: '', code: 0 });

    const result = await detectServicesHealth(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('disk: 92% used');
  });

  it('detects SSH failure', async () => {
    mockSsh.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await detectServicesHealth(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('unreachable');
  });

  it('ignores optional containers when healthy', async () => {
    const dockerOutput = [
      'bridge|Up 2 hours (healthy)',
      'indexer|Up 2 hours (healthy)',
      'explorer|Up 2 hours (healthy)',
      'gateway|Up 2 hours (healthy)',
      'postgres|Up 2 hours',
      'redis|Up 2 hours',
      'prometheus|Up 2 hours',
      'grafana|Up 2 hours',
    ].join('\n');

    mockSsh.mockResolvedValueOnce({ stdout: dockerOutput, stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '45%\n', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '60', stderr: '', code: 0 });

    const result = await detectServicesHealth(baseConfig);
    expect(result.detected).toBe(false);
  });

  it('warns on stopped optional container', async () => {
    const dockerOutput = [
      'bridge|Up 2 hours (healthy)',
      'indexer|Up 2 hours (healthy)',
      'explorer|Up 2 hours (healthy)',
      'gateway|Up 2 hours (healthy)',
      'postgres|Up 2 hours',
      'redis|Up 2 hours',
      'grafana|Exited (1) 10 minutes ago',
    ].join('\n');

    mockSsh.mockResolvedValueOnce({ stdout: dockerOutput, stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '45%\n', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: '60', stderr: '', code: 0 });

    const result = await detectServicesHealth(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('grafana: STOPPED (optional)');
  });
});
