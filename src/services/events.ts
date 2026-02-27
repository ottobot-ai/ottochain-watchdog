/**
 * Event Publisher
 *
 * Writes watchdog events (restarts, lifecycle) directly to Postgres.
 * The services monitor will pick these up for display on the status page.
 */

import pg from 'pg';
import type { Config } from '../config.js';
import type { DetectionResult, RestartScope, Layer } from '../types.js';
import { log } from '../logger.js';

const { Pool } = pg;

export type WatchdogEventType =
  | 'RESTART'
  | 'RESTART_FAILED'
  | 'WATCHDOG_START'
  | 'WATCHDOG_STOP';

export type EventSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface WatchdogEvent {
  eventType: WatchdogEventType;
  condition?: string;
  severity?: EventSeverity;
  scope?: RestartScope;
  affectedNodes?: string[];
  affectedLayers?: Layer[];
  success?: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Event publisher that writes directly to Postgres.
 * Falls back gracefully if Postgres is unavailable.
 */
export class EventPublisher {
  private pool: pg.Pool | null = null;
  private postgresAvailable: boolean = true;

  constructor(config: Config) {
    this.initPostgres(config);
  }

  private initPostgres(config: Config): void {
    if (!config.postgresUrl) {
      log('[Events] No Postgres URL configured, event publishing disabled');
      this.postgresAvailable = false;
      return;
    }

    try {
      this.pool = new Pool({
        connectionString: config.postgresUrl,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      this.pool.on('error', (err) => {
        log(`[Events] Postgres pool error: ${err.message}`);
        this.postgresAvailable = false;
      });
    } catch (err) {
      log(`[Events] Failed to initialize Postgres: ${err}`);
      this.postgresAvailable = false;
    }
  }

  /**
   * Publish an event to the monitoring_events table.
   * Fire-and-forget — doesn't throw on failure.
   */
  async publish(event: WatchdogEvent): Promise<void> {
    if (!this.pool || !this.postgresAvailable) {
      log(`[Events] Postgres unavailable, skipping event: ${event.eventType}`);
      return;
    }

    try {
      await this.pool.query(
        `INSERT INTO monitoring_events 
         (event_type, condition, severity, scope, affected_nodes, affected_layers, success, message, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.eventType,
          event.condition ?? null,
          event.severity ?? 'INFO',
          event.scope ?? null,
          event.affectedNodes ?? null,
          event.affectedLayers ?? null,
          event.success ?? null,
          event.message ?? null,
          event.details ? JSON.stringify(event.details) : null,
        ]
      );

      log(`[Events] Published ${event.eventType}: ${event.condition ?? event.message ?? 'ok'}`);
    } catch (err) {
      // Check for table not exists error
      if (err instanceof Error && err.message.includes('does not exist')) {
        log('[Events] monitoring_events table does not exist, skipping event publishing');
        this.postgresAvailable = false;
      } else {
        log(`[Events] Failed to publish event: ${err}`);
      }
    }
  }

  /**
   * Publish a restart event.
   */
  async publishRestart(
    detection: DetectionResult,
    scope: RestartScope,
    success: boolean,
    error?: string,
  ): Promise<void> {
    await this.publish({
      eventType: success ? 'RESTART' : 'RESTART_FAILED',
      condition: detection.condition,
      severity: 'CRITICAL',
      scope,
      affectedNodes: detection.affectedNodes,
      affectedLayers: detection.affectedLayers,
      success,
      message: success
        ? `Restart completed: ${detection.condition}`
        : `Restart failed: ${error ?? 'unknown error'}`,
      details: {
        detectionDetails: detection.details,
        error,
      },
    });
  }

  /**
   * Publish watchdog lifecycle events.
   */
  async publishLifecycle(started: boolean): Promise<void> {
    await this.publish({
      eventType: started ? 'WATCHDOG_START' : 'WATCHDOG_STOP',
      severity: 'INFO',
      message: started ? 'Watchdog service started' : 'Watchdog service stopped',
    });
  }

  /**
   * Close the connection pool.
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
