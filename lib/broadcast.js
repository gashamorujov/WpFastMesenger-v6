/**
 * Broadcast engine v2 — hər recipient üçün AYRI real WhatsApp göndərişi.
 *
 * Bu fayl mesaj göndərmə mühərrikinin sıfırdan yenidən qurulmuş versiyasıdır.
 *
 * Zəmanətlər:
 *  - recipientlər BİR-BİR (ardıcıl) emal olunur — heç vaxt paralel deyil
 *    (WhatsApp rate-limit üçün stabil);
 *  - bir recipientin xətası DİGƏRLƏRİNİ dayandırmır (per-target izolyasiya);
 *  - hər göndərişdən əvvəl ləğv (cancel) yoxlanılır — 🛑 Dayandır işləyir;
 *  - "sent" statusu yalnız WhatsApp client cavabından sonra verilir:
 *      ✅ göndərildi — sendMessage uğurlu oldu (+ istəyə görə server ACK);
 *      ❌ göndərilmədi — WhatsApp xəta qaytardı;
 *      ⚠ atlandı — WhatsApp-da qeydiyyatda deyil / duplicate guard;
 *  - loop YALNIZ socket həqiqətən qapalı olduqda dayanır; müvəqqəti
 *    "Connection Closed" blipləri birinci göndərişdən sonra prosesi
 *    DAYANDIRMAZ — retry edilir və digər nömrələrə keçilir;
 *  - socket vəziyyəti naməlumdursa və 3 ardıcıl bağlantı xətası alınırsa,
 *    loop dayanır (real qopma ehtimalı) — job bərpa üçün "interrupted" olur;
 *  - heç bir süni limit yoxdur — 1, 10, 50, 100, 1000+ recipient işləyir.
 */
const { sleep } = require('./myfunc');
const { jidForPhone } = require('./jidUtils');

// Baileys WAMessageStatus: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
const MSG_STATUS_ERROR = 0;
const MSG_STATUS_SERVER_ACK = 2;

const CONNECTION_ERROR_HINTS = ['connection closed', 'connection lost', 'not open', 'timedout', 'socket error', 'closed', 'stream error'];

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_DELAY_MIN_MS = 3000;
const DEFAULT_DELAY_MAX_MS = 7000;
const RETRY_BACKOFF_MS = 2000;

// Socket vəziyyəti naməlum olduqda ardıcıl bağlantı xətası limiti
const MAX_CONSECUTIVE_CONNECTION_ERRORS = 3;

/**
 * WebSocket vəziyyəti: 'open' | 'closed' | 'unknown'.
 * Baileys müvəqqəti bliplərdə də "Connection Closed" ata bilər — loop
 * yalnız həqiqətən qapalı socketdə dayanmalıdır.
 */
function wsState(sock) {
  try {
    const ws = sock?.ws;
    if (!ws) return 'unknown';
    if (typeof ws.isOpen === 'boolean') return ws.isOpen ? 'open' : 'closed';
    if (typeof ws.readyState === 'number') return ws.readyState === 1 ? 'open' : 'closed'; // WebSocket.OPEN
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Serverin göndəriş haqqında qərarını gözləyir:
 *   'sent'  — server qəbul etdi (status >= SERVER_ACK)
 *   'error' — server RƏDD etdi (status ERROR — qeydiyyatsız/məhdudiyyətli recipient)
 *   null    — vaxt bitdi (sendMessage uğurlu idi → qəbul edilmiş sayılır)
 */
function waitForAck(sock, messageId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    const handler = (updates) => {
      if (!Array.isArray(updates)) return;
      for (const u of updates) {
        if (u.key?.id !== messageId) continue;
        const status = u.status ?? 1; // PENDING
        if (status === MSG_STATUS_ERROR) return finish('error');
        if (status >= MSG_STATUS_SERVER_ACK) return finish('sent');
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
 * Bir jid-ə bir payload göndərir (retry-lərlə).
 *
 * Xəta izolyasiyası: adi xəta (və ya server rəddi) YALNIZ bu recipienti
 * uğursuz edir — çağıran loop digərlərinə davam edir. Loop yalnız socket
 * həqiqətən qapalıdırsa dayanır (connectionLost).
 *
 * @returns {Promise<{ok: boolean, connectionLost?: boolean, connectionHint?: boolean, error?: string, ack?: 'sent'|'pending'|null}>}
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
      if (ack === 'error') {
        // Server rədd etdi: nömrə WhatsApp-da deyil və ya məhdudiyyət var.
        // Retry mənasızdır — yalnız bu nömrə uğursuz sayılır, digərləri davam edir.
        return { ok: false, error: 'WhatsApp tərəfindən qəbul edilmədi (qeydiyyatda deyil və ya məhdudiyyət)' };
      }
      return { ok: true, ack: ack || (opts.ackTracking ? 'pending' : null) };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e || '').toLowerCase();
      const isHint = CONNECTION_ERROR_HINTS.some((h) => msg.includes(h));
      const state = wsState(sock);

      // Yalnız socket HƏQİQƏTƏN qapalıdırsa loop dayanır (real connection loss)
      if (isHint && state === 'closed') {
        return { ok: false, connectionLost: true, error: e.message };
      }
      if (attempt < maxRetries) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      if (attempt === maxRetries) {
        return { ok: false, error: lastErr?.message || 'Unknown error', connectionHint: isHint && state !== 'open' };
      }
    }
  }
  return { ok: false, error: lastErr?.message || 'Unknown error' };
}

/**
 * WhatsApp qeydiyyat pre-check (USync) — hamısı üçün bir dəfə.
 * Uğursuz olsa belə göndərmə dayanmır (bütün nömrələr "naməlum" sayılır).
 */
async function preflightRegistered(sock, targets, opts) {
  if (!opts.checkRegistered || typeof sock.onWhatsApp !== 'function' || targets.length === 0) return null;
  try {
    const { checkRegistered } = require('./waPresenceHelper');
    return await checkRegistered(sock, targets.map((t) => t.phone || t.jid?.split('@')[0] || ''));
  } catch {
    return null;
  }
}

/** Recipientin atlanma səbəbi (yoxdursa null — göndərilir). */
function skipReasonFor(phone, registeredMap, opts) {
  if (registeredMap && opts.skipUnregistered && registeredMap.get(phone) === false) {
    return 'WhatsApp-da qeydiyyatda deyil';
  }
  if (opts.duplicateGuard && opts.duplicateGuard.isDuplicate(phone)) {
    return 'Eyni mesaj yaxın vaxtda artıq göndərilib';
  }
  return null;
}

/**
 * Payload-ı bütün recipientlərə ardıcıl göndərir.
 *
 * @param {object} sock — Baileys socket
 * @param {Array<{jid: string, label?: string, phone?: string}>} targets
 * @param {object} payload — Baileys sendMessage məzmunu
 * @param {object} [opts]
 * @param {() => boolean} [opts.isCancelled]
 * @param {(u: {phone?, label?, status: 'sent'|'failed'|'skipped', error?, reason?, done: number, total: number}) => void} [opts.onProgress]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.delayMinMs]
 * @param {number} [opts.delayMaxMs]
 * @param {boolean} [opts.checkRegistered]
 * @param {boolean} [opts.skipUnregistered]
 * @param {{isDuplicate: (phone) => boolean, markSent: (phone) => void}} [opts.duplicateGuard]
 * @param {boolean} [opts.ackTracking]
 * @param {number} [opts.ackTimeoutMs]
 * @returns {Promise<{total: number, success: number, fail: number, skip: number, delivered: number, failed: Array, skipped: Array, ms: number, interrupted: boolean}>}
 */
async function broadcast(sock, targets, payload, opts = {}) {
  const total = targets.length;
  const start = Date.now();
  const isCancelled = opts.isCancelled || (() => false);
  const onProgress = opts.onProgress || (() => {});
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delayMin = opts.delayMinMs ?? DEFAULT_DELAY_MIN_MS;
  const delayMax = opts.delayMaxMs ?? DEFAULT_DELAY_MAX_MS;

  const summary = {
    total,
    success: 0,
    fail: 0,
    skip: 0,
    delivered: 0,
    failed: [],
    skipped: [],
    ms: 0,
    interrupted: false,
  };

  const registeredMap = await preflightRegistered(sock, targets, opts);

  let consecutiveConnectionErrors = 0;

  // ─── Əsas loop: hər recipient AYRI emal olunur ───
  for (let i = 0; i < total; i++) {
    if (isCancelled()) { summary.interrupted = true; break; }

    const target = targets[i];
    const phone = target.phone || target.jid?.split('@')[0] || '';
    const label = target.label || phone;

    // Qeydiyyatsız / duplicate → atlanır, digərləri davam edir
    const reason = skipReasonFor(phone, registeredMap, opts);
    if (reason) {
      summary.skip++;
      summary.skipped.push({ phone, label, reason });
      onProgress({ phone, label, status: 'skipped', reason, done: i + 1, total });
      continue;
    }

    // Real WhatsApp göndərişi (hər sətir/nömrə üçün ayrıca)
    const res = await sendOne(sock, target.jid, payload, maxRetries, {
      ackTracking: opts.ackTracking,
      ackTimeoutMs: opts.ackTimeoutMs,
    });

    if (res.ok) {
      summary.success++;
      consecutiveConnectionErrors = 0;
      if (res.ack === 'sent') summary.delivered++;
      if (opts.duplicateGuard) opts.duplicateGuard.markSent(phone);
      onProgress({ phone, label, status: 'sent', done: i + 1, total });
    } else if (res.connectionLost) {
      // Real bağlantı qopması → loop dayanır, job "interrupted" olur (resume)
      summary.interrupted = true;
      summary.fail++;
      summary.failed.push({ phone, label, error: res.error || 'Bağlantı qırıldı' });
      onProgress({ phone, label, status: 'failed', error: res.error || 'Bağlantı qırıldı', done: i + 1, total });
      break;
    } else {
      summary.fail++;
      summary.failed.push({ phone, label, error: res.error || 'Göndərilmədi' });
      onProgress({ phone, label, status: 'failed', error: res.error || 'Göndərilmədi', done: i + 1, total });

      if (res.connectionHint) {
        consecutiveConnectionErrors++;
        // Socket naməlumdur və ardıcıl bağlantı xətası gəlir → real qopma
        // ehtimalı yüksəkdir: loop-u dayandır ki, job bərpa olunsun.
        if (consecutiveConnectionErrors >= MAX_CONSECUTIVE_CONNECTION_ERRORS) {
          summary.interrupted = true;
          break;
        }
      } else {
        consecutiveConnectionErrors = 0;
      }
    }

    // Göndərişlər arası təsadüfi fasilə (rate limiting / stabillik)
    if (i < total - 1 && !isCancelled() && !summary.interrupted) {
      await sleep(delayMin + Math.random() * (delayMax - delayMin));
    }
  }

  summary.ms = Date.now() - start;
  return summary;
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} dəqiqə ${s} saniyə` : `${s} saniyə`;
}

module.exports = { broadcast, formatDuration, jidForPhone, sendOne };
