/**
 * Monitoring Event Publisher
 *
 * Publishes monitoring events (restarts, alerts, resolutions) to Postgres
 * for consumption by the status page via packages/monitor.
 */

import type { Config } from '../config.js';
import type { DetectionResult, RestartScope, Layer } from '../types.js';
import { log } from '../logger.js';

export type MonitoringEventType =
  | 'RESTART'
  | 'ALERT'
  | 'RESOLVED'
  | 'MONITORING_START'
  | 'MONITORING_STOP';

export type MonitoringSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface MonitoringEvent {
  eventType: MonitoringEventType;
  condition?: string;
  severity?: MonitoringSeverity;
  scope?: RestartScope;
  affectedNodes?: string[];
  affectedLayers?: Layer[];
  success?: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Event publisher that POSTs to the monitor service.
 * Falls back gracefully if monitor is unavailable.
 */
export class EventPublisher {
  private monitorUrl: string | undefined;
  private apiKey: string | undefined;

  constructor(config: Config) {
    this.monitorUrl = config.monitorUrl;
    this.apiKey = config.monitorApiKey;
  }

  /**
   * Publish an event to the monitoring database.
   * Fire-and-forget — doesn't throw on failure.
   */
  async publish(event: MonitoringEvent): Promise<void> {
    if (!this.monitorUrl) {
      log(`[Events] No monitor URL configured, skipping event: ${event.eventType}`);
      return;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.monitorUrl}/api/monitoring/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        log(`[Events] Failed to publish event: ${response.status} ${response.statusText}`);
      } else {
        log(`[Events] Published ${event.eventType}: ${event.condition ?? event.message ?? 'ok'}`);
      }
    } catch (err) {
      log(`[Events] Failed to publish event: ${err}`);
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
      eventType: 'RESTART',
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
   * Publish an alert event.
   */
  async publishAlert(
    condition: string,
    severity: MonitoringSeverity,
    message: string,
    affectedNodes?: string[],
    affectedLayers?: Layer[],
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.publish({
      eventType: 'ALERT',
      condition,
      severity,
      affectedNodes,
      affectedLayers,
      message,
      details,
    });
  }

  /**
   * Publish a resolution event (alert condition cleared).
   */
  async publishResolved(
    condition: string,
    message: string,
  ): Promise<void> {
    await this.publish({
      eventType: 'RESOLVED',
      condition,
      severity: 'INFO',
      message,
    });
  }

  /**
   * Publish monitoring service lifecycle events.
   */
  async publishLifecycle(started: boolean): Promise<void> {
    await this.publish({
      eventType: started ? 'MONITORING_START' : 'MONITORING_STOP',
      severity: 'INFO',
      message: started ? 'Monitoring service started' : 'Monitoring service stopped',
    });
  }
}
