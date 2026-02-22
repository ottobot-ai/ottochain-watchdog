/**
 * Metagraph Health Monitor — Shared Types
 */

// ── Layer identifiers ─────────────────────────────────────────────────────────

export type LayerName = 'GL0' | 'ML0' | 'CL1' | 'DL1';

export interface LayerConfig {
  name:  LayerName;
  port:  number;
}

export interface NodeInfo {
  nodeId: string;    // "1" | "2" | "3"
  host:   string;   // IP address
  layers: LayerConfig[];
}

// ── Cluster state ─────────────────────────────────────────────────────────────

export interface ClusterPeer {
  id:    string;
  ip?:   string;
  state: string;
}

export interface NodeClusterView {
  nodeId:   string;
  layer:    LayerName;
  host:     string;
  port:     number;
  peers:    ClusterPeer[];
  polledAt: string;
  error?:   string;
}

export interface ClusterSnapshot {
  layer:     LayerName;
  timestamp: string;
  views:     NodeClusterView[];
}

// ── Health conditions ─────────────────────────────────────────────────────────

export type HealthCondition =
  | 'HEALTHY'
  | 'FORK_DETECTED'
  | 'SNAPSHOT_STALL'
  | 'NODE_UNREACHABLE'
  | 'MINORITY_PARTITION';

export interface HealthEvent {
  condition:   HealthCondition;
  layer:       LayerName;
  nodeIds:     string[];
  description: string;
  timestamp:   string;
  suggestedAction?: RestartScope;
}

// ── Restart orchestration ─────────────────────────────────────────────────────

export type RestartScope =
  | 'IndividualNode'
  | 'FullLayer'
  | 'FullMetagraph';

export interface RestartPlan {
  scope:         RestartScope;
  layer?:        LayerName;
  targetNodeId?: string;
  seedNodeId?:   string;
  reason:        string;
}

// ── Snapshot / ordinal tracking ───────────────────────────────────────────────

export interface OrdinalSnapshot {
  nodeId:    string;
  layer:     LayerName;
  ordinal:   number;
  timestamp: string;
}

// ── GL0 fork detection ────────────────────────────────────────────────────────

export interface GL0NodeState {
  nodeId:  string;
  ordinal: number;
}
