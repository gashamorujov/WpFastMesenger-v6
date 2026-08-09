/**
 * Broadcast engine — sends a prepared payload to a list of targets
 * sequentially (never in parallel) with per-target error isolation,
 * retries, cancellation and progress reporting.
 *
 * Design guarantees:
 *  - targets are processed one at a time (WhatsApp rate-limit friendly)
 *  - one failing target never stops the rest
 *  - connection loss stops the loop and reports `interrupted: true`
 *    (the caller marks the job 'interrupted' for later resume)
 *  - duplicate-send guard: phones sent recently are skipped (configurable)
 *  - optional presence pre-check: numbers known NOT to be on WhatsApp are
 *    skipped before any send attempt
 */
const { sleep } = require('./myfunc');
const { jidForPhone } = require('./jidUtils');

const CONNECTION_ERROR_HINTS = ['connection closed', 'connection lost', 'not open', 'timedout', 'socket error', 'closed', 'stream error'];

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_DELAY_MIN_MS = 3000;
const DEFAULT_DELAY_MAX_MS = 7000;
const RETRY_BACKOFF_MS = 2000;

/**
 * Wait for a server ACK (status >= SERVER_ACK) for a sent message.
 * The message was already accepted by the server (sendMessage resolved);
 * this is an additional delivery-verification layer. Never FAILS a send —
 * only refines the reported delivery status.
 */
function waitForAck(sock, messageId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    const handler = (updates) => {
      if (!Array.isArray(updates)) return;
      for (const u of updates) {
        if (u.key?.id === messageId && (u.status ?? 1) >= 2) return finish('sent');
      }
    };
    function finish(v) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.ev?.off?.('messages.update', handler); } catch {}
      resolve(v);
    }
    try { sock.ev?.on?.('messages.update', handler); } catch { finish(null); }
  });
}

/**
 * Send one payload to one jid with retries.
 * @returns {Promise<{ok: boolean, connectionLost?: boolean, error?: string, ack?: 'sent'|'pending'|null}>}
 */
async function sendOne(sock, jid, payload, maxRetries = DEFAULT_MAX_RETRIES, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sent = await sock.sendMessage(jid, payload, { quoted: null });
      let ack = null;
      const msgId = sent?.key?.id;
      if (msgId && opts.ackTracking && sock.ev && typeof sock.ev.on === 'function') {
        ack = await waitForAck(sock, msgId, opts.ackTimeoutMs || 5000);
      }
      return { ok: true, ack: ack || (opts.ackTracking ? 'pending' : null) };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e || '').toLowerCase();
      if (CONNECTION_ERROR_HINTS.some((h) => msg.includes(h))) {
        return { ok: false, connectionLost: true, error: e.message };
      }
      if (attempt < maxRetries) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  return { ok: false, error: lastErr?.message || 'Unknown error' };
}

/**
 * Broadcast a payload to all targets sequentially.
 *
 * @param {object} sock — Baileys socket
 * @param {Array<{jid: string, label?: string, phone?: string}>} targets
 * @param {object} payload — Baileys sendMessage content
 * @param {object} [opts]
 * @param {() => boolean} [opts.isCancelled] — stop between items when true
 * @param {(update: {phone?: string, label?: string, status: 'sent'|'failed'|'skipped', error?: string, reason?: string, done: number, total: number}) => void} [opts.onProgress]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.delayMinMs]
 * @param {number} [opts.delayMaxMs]
 * @param {boolean} [opts.checkRegistered] — pre-check via sock.onWhatsApp
 * @param {boolean} [opts.skipUnregistered] — skip numbers not on WhatsApp
 * @param {{isDuplicate: (phone: string) => boolean, markSent: (phone: string) => void}} [opts.duplicateGuard]
 * @param {boolean} [opts.ackTracking] — wait for server ACK per message
 * @param {number} [opts.ackTimeoutMs]
 * @returns {Promise<{total: number, success: number, fail: number, skip: number, failed: Array<{phone?: string, label: string, error: string}>, skipped: Array<{phone?: string, label: string, reason: string}>, ms: number, interrupted: boolean}>}
 */
async function broadcast(sock, targets, payload, opts = {}) {
  const total = targets.length;
  let success = 0;
  let fail = 0;
  let skip = 0;
  let delivered = 0;
  let interrupted = false;
  const failed = [];
  const skipped = [];
  const start = Date.now();
  const isCancelled = opts.isCancelled || (() => false);
  const onProgress = opts.onProgress || (() => {});
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delayMin = opts.delayMinMs ?? DEFAULT_DELAY_MIN_MS;
  const delayMax = opts.delayMaxMs ?? DEFAULT_DELAY_MAX_MS;

  // Presence pre-check (only when the socket exposes it)
  let registeredMap = null;
  if (opts.checkRegistered && typeof sock.onWhatsApp === 'function' && targets.length > 0) {
    try {
      const { checkRegistered } = require('./waPresenceHelper');
      registeredMap = await checkRegistered(sock, targets.map((t) => t.phone || t.jid?.split('@')[0]));
    } catch {
      registeredMap = null;
    }
  }

  for (let i = 0; i < total; i++) {
    if (isCancelled()) { interrupted = true; break; }

    const target = targets[i];
    const phone = target.phone || target.jid?.split('@')[0] || '';
    const label = target.label || phone;

    // Skip numbers known not to be registered on WhatsApp
    if (registeredMap && opts.skipUnregistered && registeredMap.get(phone) === false) {
      skip++;
      skipped.push({ phone, label, reason: 'WhatsApp-da qeydiyyatda deyil' });
      onProgress({ phone, label, status: 'skipped', reason: 'WhatsApp-da qeydiyyatda deyil', done: i + 1, total });
      continue;
    }

    // Duplicate-send guard (same message content sent recently)
    if (opts.duplicateGuard && opts.duplicateGuard.isDuplicate(phone)) {
      skip++;
      skipped.push({ phone, label, reason: 'Eyni mesaj yaxın vaxtda artıq göndərilib' });
      onProgress({ phone, label, status: 'skipped', reason: 'Eyni mesaj yaxın vaxtda artıq göndərilib', done: i + 1, total });
      continue;
    }

    const res = await sendOne(sock, target.jid, payload, maxRetries, {
      ackTracking: opts.ackTracking,
      ackTimeoutMs: opts.ackTimeoutMs,
    });

    if (res.ok) {
      success++;
      if (res.ack === 'sent') delivered++;
      if (opts.duplicateGuard) opts.duplicateGuard.markSent(phone);
      onProgress({ phone, label, status: 'sent', done: i + 1, total });
    } else if (res.connectionLost) {
      interrupted = true;
      fail++;
      failed.push({ phone, label, error: res.error || 'Bağlantı qırıldı' });
      onProgress({ phone, label, status: 'failed', error: res.error || 'Bağlantı qırıldı', done: i + 1, total });
      break; // stop the loop — connection is gone
    } else {
      fail++;
      failed.push({ phone, label, error: res.error || 'Göndərilmədi' });
      onProgress({ phone, label, status: 'failed', error: res.error || 'Göndərilmədi', done: i + 1, total });
    }

    // Random delay between sends (rate limiting / stability)
    if (i < total - 1 && !isCancelled() && !interrupted) {
      const delay = delayMin + Math.random() * (delayMax - delayMin);
      await sleep(delay);
    }
  }

  return {
    total,
    success,
    fail,
    skip,
    delivered,
    failed,
    skipped,
    ms: Date.now() - start,
    interrupted,
  };
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} dəqiqə ${s} saniyə` : `${s} saniyə`;
}

module.exports = { broadcast, formatDuration, jidForPhone, sendOne };
