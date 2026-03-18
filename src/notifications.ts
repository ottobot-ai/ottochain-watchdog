/**
 * Notification Service
 *
 * Sends alerts via Telegram when watchdog detects issues or performs restarts.
 * Integrates with OpenClaw's alert bot for AI-assisted response.
 */

import { log } from './logger.js';
import type { DetectionResult, RestartScope } from './types.js';

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

export interface NotificationConfig {
  telegram?: TelegramConfig;
}

/**
 * Send a Telegram message using the Bot API.
 */
async function sendTelegram(
  config: TelegramConfig,
  message: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
): Promise<boolean> {
  if (!config.enabled || !config.botToken || !config.chatId) {
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      log(`[Notify] Telegram error: ${error}`);
      return false;
    }

    log('[Notify] Telegram message sent');
    return true;
  } catch (err) {
    log(`[Notify] Failed to send Telegram message: ${err}`);
    return false;
  }
}

/**
 * Notification manager for watchdog events.
 */
export class NotificationService {
  private telegram?: TelegramConfig;

  constructor(config: NotificationConfig) {
    this.telegram = config.telegram;
    if (this.telegram?.enabled) {
      log('[Notify] Telegram notifications enabled');
    }
  }

  /**
   * Notify on issue detection (before restart attempt).
   */
  async notifyIssueDetected(detection: DetectionResult): Promise<void> {
    if (!this.telegram?.enabled) return;

    const severity = detection.restartScope === 'full-metagraph' ? '🔴' : '🟡';
    const layers = detection.affectedLayers?.join(', ') ?? 'unknown';
    const nodes = detection.affectedNodes?.join(', ') ?? 'all';

    const message = `${severity} <b>OttoChain Watchdog Alert</b>

<b>Condition:</b> ${detection.condition}
<b>Details:</b> ${detection.details}
<b>Affected Layers:</b> ${layers}
<b>Affected Nodes:</b> ${nodes}
<b>Restart Scope:</b> ${detection.restartScope}

Attempting automatic recovery...`;

    await sendTelegram(this.telegram, message);
  }

  /**
   * Notify on restart completion.
   */
  async notifyRestartComplete(
    detection: DetectionResult,
    scope: RestartScope,
    success: boolean,
    error?: string,
  ): Promise<void> {
    if (!this.telegram?.enabled) return;

    const icon = success ? '✅' : '❌';
    const status = success ? 'Recovery successful' : 'Recovery FAILED';

    const message = `${icon} <b>OttoChain Watchdog ${status}</b>

<b>Condition:</b> ${detection.condition}
<b>Scope:</b> ${scope}
${error ? `<b>Error:</b> ${error}` : ''}

${success ? 'Cluster should be recovering.' : 'Manual intervention may be required.'}`;

    await sendTelegram(this.telegram, message);
  }

  /**
   * Notify when watchdog suspends automatic restarts.
   */
  async notifyRestartsSuspended(
    consecutiveFailures: number,
    lastCondition: string,
  ): Promise<void> {
    if (!this.telegram?.enabled) return;

    const message = `🚨 <b>OttoChain Watchdog SUSPENDED</b>

Automatic restarts have been disabled after ${consecutiveFailures} consecutive failures.

<b>Last condition:</b> ${lastCondition}

<b>Manual intervention required.</b>

To re-enable: POST to watchdog /api/reset or fix the underlying issue.`;

    await sendTelegram(this.telegram, message);
  }

  /**
   * Notify on watchdog lifecycle events.
   */
  async notifyLifecycle(started: boolean): Promise<void> {
    if (!this.telegram?.enabled) return;

    const message = started
      ? '🟢 <b>OttoChain Watchdog Started</b>\n\nAutomatic cluster monitoring is now active.'
      : '🔴 <b>OttoChain Watchdog Stopped</b>\n\nAutomatic cluster monitoring has stopped.';

    await sendTelegram(this.telegram, message);
  }

  /**
   * Notify when restarts are re-enabled (health recovered).
   */
  async notifyRestartsResumed(): Promise<void> {
    if (!this.telegram?.enabled) return;

    const message = `🟢 <b>OttoChain Watchdog Resumed</b>

Cluster health has recovered. Automatic restarts are now re-enabled.`;

    await sendTelegram(this.telegram, message);
  }
}
