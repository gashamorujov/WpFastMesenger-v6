/**
 * BroadcastService — bulk-message orchestration.
 *
 * All .ss broadcasts (new, resumed, retried) run through ONE global
 * serialized queue so WhatsApp rate limits are respected even when multiple
 * chats/jobs are active at the same time.
 *
 * Lifecycle (persisted via modules/jobStore):
 *   running → completed | cancelled
 *   running → interrupted (connection lost / process died) → running (auto-resume)
 *
 * Safety:
 *  - per-target status is persisted after every send
 *  - already-sent targets are never re-sent (resume/retry skip them)
 *  - cross-job duplicate guard (modules/recentSends)
 *  - numbers known NOT to be on WhatsApp are skipped before sending
 *  - `.cc` cancels a job; cancelled jobs are never resumed
 */
const fs = require('fs-extra');
const path = require('path');
const { Queue } = require('./queue');
const jobStore = require('./jobStore');
const recentSends = require('./recentSends');
const wa = require('./whatsappManager');
const { broadcast, formatDuration, jidForPhone } = require('../lib/broadcast');
const { getTelegramMessenger, sessionManager } = require('./services');
const { STATES } = require('./sessionManager');
const { formatPhone } = require('../lib/phone');
const { makeLogger } = require('./logger');
const settings = require('../settings');

const LOG = makeLogger('BROADCAST');

const JOBS_DIR = path.join(__dirname, '..', 'data', 'jobs');

/** Stable identity of a payload — used by the cross-job duplicate guard. */
function payloadKeyForSpec(spec) {
  if (!spec) return '';
  const parts = [spec.type, spec.text, spec.caption, spec.fileName, spec.mimetype, spec.latitude, spec.longitude];
  const body = parts.filter((v) => v !== undefined && v !== null && v !== '').join('\u0000');
  return require('crypto').createHash('sha1').update(body || 'empty').digest('hex');
}

const queuedJobIds = new Set();
const lastProgressAt = new Map();

const globalQueue = new Queue({
  onItem: async (jobId) => {
    try {
      await executeJob(jobId);
    } catch (e) {
      LOG.error('Job execution error:', jobId, e.message);
      const job = jobStore.read(jobId);
      if (job) {
        jobStore.markInterrupted(job);
        notifyChat(job, `❌ İş #${job.id} xəta səbəbindən dayandırıldı:\n${e.message}\nWhatsApp yenidən qoşulanda avtomatik bərpa olunacaq.`);
      }
    } finally {
      queuedJobIds.delete(jobId);
      lastProgressAt.delete(jobId);
    }
  },
  delayMin: 2000,
  delayMax: 4000,
});

// ─── Payload (de)serialization ───

function payloadFromSpec(spec) {
  if (!spec) return null;
  try {
    switch (spec.type) {
      case 'text':
        return { text: spec.text };
      case 'image':
        return { image: fs.readFileSync(spec.file), caption: spec.caption || '' };
      case 'video':
        return { video: fs.readFileSync(spec.file), caption: spec.caption || '', mimetype: spec.mimetype || 'video/mp4' };
      case 'video_note':
        return { video: fs.readFileSync(spec.file), ptt: true };
      case 'gif':
        return { video: fs.readFileSync(spec.file), gifPlayback: true, caption: spec.caption || '', mimetype: spec.mimetype || 'video/mp4' };
      case 'voice':
        return { audio: fs.readFileSync(spec.file), mimetype: spec.mimetype || 'audio/ogg; codecs=opus', ptt: true };
      case 'audio':
        return { audio: fs.readFileSync(spec.file), mimetype: spec.mimetype || 'audio/mpeg', ptt: false, caption: spec.caption || '' };
      case 'document':
        return { document: fs.readFileSync(spec.file), fileName: spec.fileName || 'document', mimetype: spec.mimetype || 'application/octet-stream', caption: spec.caption || '' };
      case 'sticker':
        return { sticker: fs.readFileSync(spec.file) };
      case 'contact':
        return { contacts: spec.contact };
      case 'location':
        return { location: { degreesLatitude: spec.latitude, degreesLongitude: spec.longitude } };
      default:
        return null;
    }
  } catch (e) {
    LOG.error('payloadFromSpec error:', e.message);
    return null;
  }
}

// ─── Notifications ───

function notifyChat(job, text, extra) {
  const m = getTelegramMessenger();
  if (!m || !job.chatId) return null;
  return m.sendText(job.chatId, text, extra || {}).catch((e) => {
    LOG.error('notifyChat failed:', e.message);
    return null;
  });
}

function progressText(job, report) {
  const total = job.targets.length;
  return (
    `📨 Göndərilir… (${report.done}/${total})\n` +
    `✅ Göndərildi: ${report.success}\n` +
    `❌ Xəta: ${report.fail}\n` +
    `⏭ Atlanıldı: ${report.skip}` +
    (report.label ? `\n👤 İndi: ${report.label}` : '')
  );
}

function maybeUpdateProgress(job, update, force = false) {
  const now = Date.now();
  const last = lastProgressAt.get(job.id) || 0;
  if (!force && now - last < 5000) return;
  lastProgressAt.set(job.id, now);

  const m = getTelegramMessenger();
  if (!m || !job.chatId) return;

  const text = progressText(job, update);
  if (job.progressMsgId) {
    m.editText(job.chatId, job.progressMsgId, text).then(() => {}).catch(() => {
      // Fallback: send a fresh message and remember its id
      m.sendText(job.chatId, text).then((sent) => {
        const fresh = jobStore.read(job.id);
        if (fresh && sent?.message_id) {
          fresh.progressMsgId = sent.message_id;
          jobStore.update(fresh);
        }
      }).catch(() => {});
    });
  } else {
    m.sendText(job.chatId, text).then((sent) => {
      const fresh = jobStore.read(job.id);
      if (fresh && sent?.message_id) {
        fresh.progressMsgId = sent.message_id;
        jobStore.update(fresh);
      }
    }).catch(() => {});
  }
}

// ─── Job execution ───

async function executeJob(jobId) {
  const job = jobStore.read(jobId);
  if (!job) return;
  if (job.state === 'cancelled' || job.state === 'completed') return;

  const sender = wa.getSenderSocket();
  if (!sender || !sender.sock) {
    jobStore.markInterrupted(job);
    notifyChat(job, '⚠️ WhatsApp bağlantısı aktiv deyil — iş bərpaya hazırdır. Qoşulduqda avtomatik davam edəcək.');
    return;
  }

  job.state = 'running';
  jobStore.update(job);

  const payload = payloadFromSpec(job.payloadSpec);
  if (!payload) {
    for (const t of job.targets) {
      if (t.status === 'pending' || t.status === 'failed') {
        jobStore.updateTarget(job, t.phone, { status: 'failed', error: 'Media faylı tapılmadı və ya dəstəklənmir' });
      }
    }
    const final = jobStore.read(job.id);
    jobStore.markCompleted(final);
    notifyChat(final, '❌ Göndərmə mümkün olmadı: media faylı silinib və ya yanlışdır.');
    cleanupMedia(final);
    return;
  }

  const pending = job.targets.filter((t) => t.status === 'pending' || t.status === 'failed');
  const targets = pending.map((t) => ({
    jid: jidForPhone(t.phone),
    label: t.name ? `${t.name} — ${formatPhone(t.phone)}` : formatPhone(t.phone),
    phone: t.phone,
  }));

  const report = await broadcast(sender.sock, targets, payload, {
    isCancelled: () => {
      const fresh = jobStore.read(job.id);
      return !fresh || fresh.state === 'cancelled';
    },
    onProgress: (u) => {
      const fresh = jobStore.read(job.id);
      if (!fresh) return;
      const t = fresh.targets.find((x) => x.phone === u.phone);
      jobStore.updateTarget(fresh, u.phone, {
        status: u.status,
        error: u.error || u.reason || null,
        attempts: u.status === 'failed' ? (t?.attempts || 0) + 1 : t?.attempts || 0,
      });
      maybeUpdateProgress(fresh, u);
    },
    checkRegistered: settings.waPresenceCheck,
    skipUnregistered: settings.waSkipUnregistered,
    duplicateGuard: {
      isDuplicate: (phone) => recentSends.isDuplicate(phone, job.payloadKey || ''),
      markSent: (phone) => recentSends.markSent(phone, job.payloadKey || ''),
    },
    maxRetries: settings.broadcastMaxRetries,
    delayMinMs: settings.broadcastDelayMinMs,
    delayMaxMs: settings.broadcastDelayMaxMs,
  });

  const final = jobStore.read(job.id);
  if (!final) return;

  if (final.state === 'cancelled') {
    jobStore.markCancelled(final);
    cleanupMedia(final);
    return;
  }

  if (report.interrupted) {
    jobStore.markInterrupted(final);
    notifyChat(final, `🔄 WhatsApp bağlantısı kəsildi — iş #${final.id} bərpaya hazırdır. Qoşulduqda avtomatik davam edəcək.\n✅ ${report.success} | ❌ ${report.fail} | ⏭ ${report.skip}`);
    return;
  }

  jobStore.markCompleted(final, report);
  sendFinalReport(final, report);
  // Media is kept with the job (until retention purge) so the retry button
  // can re-send to failed targets without asking the user for a new file.
  autoCleanSession(final.chatId);
}

function autoCleanSession(chatId) {
  const s = sessionManager.get(chatId);
  if (s.state === STATES.SS_NUMBERS || s.state === STATES.SS_CONTENT) {
    sessionManager.cancel(chatId);
  }
}

function sendFinalReport(job, report) {
  const lines = [
    '✅ Göndərmə tamamlandı.',
    '',
    `Mesaj növü: ${job.type || 'text'}`,
    `Ümumi nömrə sayı: ${job.targets.length}`,
    `✅ Uğurla göndərilənlər: ${report.success}`,
    `❌ Xəta olanlar: ${report.fail}`,
    `⏭ Atlanılanlar: ${report.skip}`,
    `Ümumi icra müddəti: ${formatDuration(report.ms)}`,
  ];

  const keyboard = [];
  if (report.failed.length > 0) {
    lines.push('', '❌ Xəta olan nömrələr:');
    for (const f of report.failed.slice(0, 15)) lines.push(`• ${f.label} — ${f.error || 'Göndərilmədi'}`);
    if (report.failed.length > 15) lines.push(`...və daha ${report.failed.length - 15} nömrə`);
    keyboard.push([{ text: '🔁 Uğursuzları yenidən cəhd et', callback_data: `sp:retry:${job.id}` }]);
  }
  if (report.skipped.length > 0) {
    lines.push('', '⏭ Atlanılan nömrələr:');
    for (const s of report.skipped.slice(0, 15)) lines.push(`• ${s.label} — ${s.reason}`);
    if (report.skipped.length > 15) lines.push(`...və daha ${report.skipped.length - 15} nömrə`);
  }
  const { MAIN_MENU_BUTTONS } = require('../lib/menu');
  keyboard.push([{ text: '🏠 Əsas menyu', callback_data: 'menu' }]);

  notifyChat(job, lines.join('\n'), { reply_markup: { inline_keyboard: keyboard } });
}

function cleanupMedia(job) {
  try {
    fs.removeSync(path.join(JOBS_DIR, job.id, 'media'));
  } catch {}
}

// ─── Public API ───

/**
 * Create a job from a built payload and enqueue it.
 * @param {{chatId: string, type: string, payloadSpec: object, targets: Array<{phone: string, name?: string}>, progressMsgId?: number, tempFile?: string|null}} input
 * @returns {object} the created job
 */
function createJob(input) {
  const job = jobStore.create({
    chatId: input.chatId,
    type: input.type,
    payloadSpec: input.payloadSpec,
    targets: input.targets,
    progressMsgId: input.progressMsgId || null,
  });
  job.payloadKey = payloadKeyForSpec(job.payloadSpec);
  jobStore.update(job);

  if (input.tempFile) {
    try {
      const mediaDir = path.join(JOBS_DIR, job.id, 'media');
      fs.ensureDirSync(mediaDir);
      const dest = path.join(mediaDir, path.basename(input.tempFile));
      fs.moveSync(input.tempFile, dest, { overwrite: true });
      job.payloadSpec.file = dest;
      jobStore.update(job);
    } catch (e) {
      LOG.error('Job media move failed:', e.message);
    }
  }

  enqueueJob(job.id);
  return job;
}

function enqueueJob(jobId) {
  if (queuedJobIds.has(jobId)) return false;
  queuedJobIds.add(jobId);
  globalQueue.push(jobId).catch(() => {});
  return true;
}

/**
 * Resume all interrupted jobs (called on boot and whenever a WhatsApp
 * socket connects). Already-queued jobs are never double-enqueued.
 * @returns {number} jobs resumed
 */
function resumeInterruptedJobs() {
  if (!wa.getSenderSocket() || !wa.getSenderSocket().sock) return 0;
  let resumed = 0;
  for (const job of jobStore.listActive()) {
    if (job.state !== 'interrupted') continue;
    if (queuedJobIds.has(job.id)) continue;
    enqueueJob(job.id);
    notifyChat(job, `🔄 İş #${job.id} bərpa edildi — davam edir...`);
    resumed++;
  }
  return resumed;
}

/** Mark 'running' jobs (crash leftovers) as interrupted, then resume. */
function recoverAndResume() {
  const recovered = jobStore.recoverInterrupted();
  for (const job of recovered) {
    LOG.info(`Recovered interrupted job ${job.id} (chat ${job.chatId})`);
  }
  return resumeInterruptedJobs();
}

/** Cancel every active job belonging to a chat (.cc). */
function cancelChatJobs(chatId) {
  let cancelled = 0;
  for (const job of jobStore.list()) {
    if (String(job.chatId) !== String(chatId)) continue;
    if (job.state !== 'running' && job.state !== 'interrupted') continue;
    const fresh = jobStore.read(job.id);
    if (!fresh) continue;
    if (fresh.state !== 'cancelled') {
      jobStore.markCancelled(fresh);
      cleanupMedia(fresh);
      cancelled++;
    }
  }
  const removed = globalQueue.removeWhere((id) => {
    const j = jobStore.read(id);
    return j && String(j.chatId) === String(chatId) && j.state === 'cancelled';
  });
  if (removed > 0) LOG.info(`Removed ${removed} queued job(s) for chat ${chatId}`);
  return cancelled;
}

/**
 * Retry the failed targets of a completed/interrupted job as a new job.
 * @param {string} jobId
 * @returns {object|null} the new job
 */
function retryFailed(jobId) {
  const old = jobStore.read(jobId);
  if (!old) return null;
  const failed = old.targets.filter((t) => t.status === 'failed');
  if (failed.length === 0) return null;

  const job = jobStore.create({
    chatId: old.chatId,
    type: old.type,
    payloadSpec: old.payloadSpec,
    targets: failed.map((t) => ({ phone: t.phone, name: t.name })),
  });
  job.payloadKey = old.payloadKey || payloadKeyForSpec(job.payloadSpec);
  jobStore.update(job);

  // Media files may have been purged — re-check before enqueueing.
  const payload = payloadFromSpec(job.payloadSpec);
  if (!payload) {
    const fresh = jobStore.read(job.id);
    for (const t of fresh.targets) {
      jobStore.updateTarget(fresh, t.phone, { status: 'failed', error: 'Media faylı artıq mövcud deyil — yeni media göndərin' });
    }
    jobStore.markCompleted(jobStore.read(job.id));
    cleanupMedia(fresh);
    notifyChat(fresh, '❌ Yenidən cəhd mümkün olmadı: orijinal media faylı silinib. Yeni mesaj üçün yenidən .ss yazın.');
    return job;
  }

  enqueueJob(job.id);
  return job;
}

/** Graceful shutdown: persist state; running jobs become resumable. */
function shutdown() {
  for (const job of jobStore.listActive()) {
    if (job.state === 'running') {
      jobStore.markInterrupted(job);
      queuedJobIds.delete(job.id);
    }
  }
  globalQueue.cancel();
  LOG.info('Broadcast service shut down; active jobs marked interrupted (resumable).');
}

/** Delete old terminal jobs (retention). */
function purgeOldJobs(maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const job of jobStore.list()) {
    if (job.state === 'completed' || job.state === 'cancelled') {
      const finished = new Date(job.finishedAt || job.updatedAt).getTime();
      if (now - finished > maxAgeMs) jobStore.deleteJob(job);
    }
  }
}

module.exports = {
  createJob,
  resumeInterruptedJobs,
  recoverAndResume,
  cancelChatJobs,
  retryFailed,
  shutdown,
  purgeOldJobs,
  payloadFromSpec,
};
