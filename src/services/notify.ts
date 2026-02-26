/**
 * Notification service — sends alerts to Discord/Telegram via webhook.
 */

import type { Config } from '../config.js';
import { log } from '../logger.js';

export async function notify(config: Config, message: string): Promise<void> {
  log(`[NOTIFY] ${message}`);

  if (!config.webhookUrl) return;

  try {
    // Discord webhook format
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `🛡️ **OttoChain Monitor**: ${message}` }),
    });
  } catch (err) {
    log(`[NOTIFY] Failed to send webhook: ${err}`);
  }
}
