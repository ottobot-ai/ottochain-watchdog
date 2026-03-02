/**
 * Node Resource Monitoring Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectNodeResourceIssues } from './node-resources.js';

vi.mock('../services/ssh.js', () => ({
  sshExec: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

import { sshExec } from '../services/ssh.js';

const mockSsh = vi.mocked(sshExec);

const baseConfig = {
  nodes: [
    { name: 'node1', ip: '10.0.0.1' },
    { name: 'node2', ip: '10.0.0.2' },
    { name: 'node3', ip: '10.0.0.3' },
  ],
  sshKeyPath: '/tmp/key',
  sshUser: 'root',
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectNodeResourceIssues()', () => {
  it('returns not-detected when all nodes within thresholds', async () => {
    for (let i = 0; i < 3; i++) {
      mockSsh.mockResolvedValueOnce({
        stdout: 'DISK:45%\nMEM:60',
        stderr: '',
        code: 0,
      });
    }

    const result = await detectNodeResourceIssues(baseConfig);
    expect(result.detected).toBe(false);
  });

  it('detects high disk usage on a node', async () => {
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:90%\nMEM:60', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:45%\nMEM:60', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:45%\nMEM:60', stderr: '', code: 0 });

    const result = await detectNodeResourceIssues(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('node1: disk 90%');
    expect(result.affectedNodes).toContain('10.0.0.1');
  });

  it('detects high memory on a node', async () => {
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:45%\nMEM:60', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:45%\nMEM:95', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:45%\nMEM:60', stderr: '', code: 0 });

    const result = await detectNodeResourceIssues(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('node2: memory 95%');
  });

  it('detects multiple issues across nodes', async () => {
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:92%\nMEM:95', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:88%\nMEM:60', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:45%\nMEM:60', stderr: '', code: 0 });

    const result = await detectNodeResourceIssues(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('node1: disk 92%');
    expect(result.details).toContain('node1: memory 95%');
    expect(result.details).toContain('node2: disk 88%');
    expect(result.affectedNodes).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('handles SSH failure gracefully', async () => {
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:45%\nMEM:60', stderr: '', code: 0 });
    mockSsh.mockRejectedValueOnce(new Error('Connection timed out'));
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:45%\nMEM:60', stderr: '', code: 0 });

    const result = await detectNodeResourceIssues(baseConfig);
    expect(result.detected).toBe(true);
    expect(result.details).toContain('node2: unreachable');
  });

  it('restartScope is always none', async () => {
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:99%\nMEM:99', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:99%\nMEM:99', stderr: '', code: 0 });
    mockSsh.mockResolvedValueOnce({ stdout: 'DISK:99%\nMEM:99', stderr: '', code: 0 });

    const result = await detectNodeResourceIssues(baseConfig);
    expect(result.restartScope).toBe('none');
  });
});
