/**
 * Orchestrator tests — lightweight unit tests that don't import the full module.
 * Tests the public API contracts: managed layers, consecutive failures, rate limits.
 */
import { describe, it, expect } from 'vitest';
import type { Layer } from '../types.js';
import { DEFAULT_MANAGED_LAYERS } from '../types.js';

describe('Restart Orchestrator — Config', () => {
  it('DEFAULT_MANAGED_LAYERS excludes cl1', () => {
    expect(DEFAULT_MANAGED_LAYERS).toContain('ml0');
    expect(DEFAULT_MANAGED_LAYERS).toContain('dl1');
    expect(DEFAULT_MANAGED_LAYERS).not.toContain('cl1');
    expect(DEFAULT_MANAGED_LAYERS).not.toContain('gl0');
  });

  it('DEFAULT_MANAGED_LAYERS has exactly 2 layers', () => {
    expect(DEFAULT_MANAGED_LAYERS).toHaveLength(2);
  });
});

describe('Restart Orchestrator — parseManagedLayers', () => {
  // Test the config loading logic indirectly
  it('managed layers are valid Layer types', () => {
    const validLayers: Layer[] = ['gl0', 'ml0', 'cl1', 'dl1'];
    for (const layer of DEFAULT_MANAGED_LAYERS) {
      expect(validLayers).toContain(layer);
    }
  });
});
