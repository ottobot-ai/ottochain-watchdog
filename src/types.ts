/** Tessellation layer identifiers */
export type Layer = 'gl0' | 'ml0' | 'cl1' | 'dl1';

export const ALL_LAYERS: Layer[] = ['gl0', 'ml0', 'cl1', 'dl1'];
export const METAGRAPH_LAYERS: Layer[] = ['ml0', 'cl1', 'dl1'];

/** Node info from /node/info */
export interface NodeInfo {
  state: string;
  id: string;
  host: string;
  publicPort: number;
  p2pPort: number;
  session?: string;
}

/** Cluster member from /cluster/info */
export interface ClusterMember {
  id: string;
  state: string;
  ip?: string;
  publicPort?: number;
  p2pPort?: number;
  session?: string;
}

/** Result of a health check on a single node+layer */
export interface NodeHealth {
  nodeIp: string;
  layer: Layer;
  reachable: boolean;
  state: string;
  cluster: ClusterMember[];
  ordinal: number;
  lastSnapshotHash?: string;
}

/** Detection result */
export interface DetectionResult {
  detected: boolean;
  condition: string;
  details: string;
  restartScope: RestartScope;
  affectedNodes?: string[];
  affectedLayers?: Layer[];
}

export type RestartScope = 'none' | 'individual-node' | 'full-layer' | 'full-metagraph';

/** Restart event for logging */
export interface RestartEvent {
  timestamp: string;
  scope: RestartScope;
  condition: string;
  layers: Layer[];
  nodes: string[];
  success: boolean;
  error?: string;
}
