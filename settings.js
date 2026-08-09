/**
 * Central configuration. All secrets come from the environment only
 * (TELEGRAM_TOKEN is required; there is no hardcoded fallback).
 */
const token = process.env.TELEGRAM_TOKEN || '';

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function boolEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v !== 'false' && v !== '0';
}

const settings = {
  telegramToken: token,
  pairNumber: process.env.PAIR_NUMBER || '',

  // WhatsApp registration pre-check (sock.onWhatsApp USync query)
  waPresenceCheck: boolEnv('WA_PRESENCE_CHECK', true),
  // Skip numbers known not to be on WhatsApp instead of trying to send
  waSkipUnregistered: boolEnv('WA_SKIP_UNREGISTERED', true),

  // Broadcast pacing (per-target random delay between sends)
  broadcastDelayMinMs: intEnv('BROADCAST_DELAY_MIN_MS', 3000),
  broadcastDelayMaxMs: intEnv('BROADCAST_DELAY_MAX_MS', 7000),
  broadcastMaxRetries: intEnv('BROADCAST_MAX_RETRIES', 2),

  // Cross-job duplicate-send guard TTL (minutes; 0 disables)
  duplicateSendTtlMin: intEnv('DUPLICATE_SEND_TTL_MIN', 10),
};

settings.version = '5.0.0';
settings.repo = 'gashamorujov/WpFastMesenger';

module.exports = settings;
