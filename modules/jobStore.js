/**
 * JobStore — persistent bulk-message job state (data/jobs/<id>.json).
 *
 * Every .ss broadcast is a "job". Its full state (targets, per-target
 * status, payload description, progress) is written to disk after every
 * send, so a crash or restart never loses the picture:
 *
 *   - targets: pending / sent / failed / skipped (per target)
 *   - state:   running / interrupted / completed / cancelled
 *
 * Resume flow: a job whose process died while running is found as
 * 'running' on the next boot → marked 'interrupted' → automatically
 * re-queued (already-sent targets are skipped). `.cc` marks a job
 * 'cancelled' — it will never be resumed.
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { makeLogger } = require('./logger');

const LOG = makeLogger('JOB-STORE');

const DATA_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(__dirname, '..', 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');

fs.ensureDirSync(JOBS_DIR);

const STATES = {
  RUNNING: 'running',
  INTERRUPTED: 'interrupted',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const TARGET_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

function fileFor(id) {
  return path.join(JOBS_DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

function newId() {
  return crypto.randomBytes(4).toString('hex') + Date.now().toString(36);
}

function read(id) {
  try {
    const raw = fs.readFileSync(fileFor(id), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(job) {
  try {
    fs.writeFileSync(fileFor(job.id), JSON.stringify(job, null, 2));
  } catch (e) {
    LOG.error('Job save failed:', e.message);
  }
}

/**
 * Create a new broadcast job.
 * @param {{chatId: string, type: string, payloadSpec: object, targets: Array<{phone: string, name?: string}>}} input
 * @returns {object} the created job
 */
function create(input) {
  const now = new Date().toISOString();
  const job = {
    id: newId(),
    chatId: String(input.chatId || ''),
    state: STATES.RUNNING,
    type: input.type || 'text',
    payloadSpec: input.payloadSpec || {},
    targets: (input.targets || []).map((t) => ({
      phone: t.phone,
      name: t.name || null,
      status: TARGET_STATUS.PENDING,
      error: null,
      attempts: 0,
    })),
    progressMsgId: input.progressMsgId || null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    successCount: 0,
    failCount: 0,
    skipCount: 0,
  };
  write(job);
  return job;
}

function update(job) {
  job.updatedAt = new Date().toISOString();
  write(job);
  return job;
}

/** Update one target and keep counters consistent. */
function updateTarget(job, phone, patch) {
  const t = job.targets.find((x) => x.phone === phone);
  if (!t) return;
  const prev = t.status;
  Object.assign(t, patch);
  const next = t.status;

  const recount = (from, to) => {
    if (from === 'sent') job.successCount = Math.max(0, job.successCount - 1);
    if (from === 'failed') job.failCount = Math.max(0, job.failCount - 1);
    if (from === 'skipped') job.skipCount = Math.max(0, job.skipCount - 1);
    if (to === 'sent') job.successCount++;
    if (to === 'failed') job.failCount++;
    if (to === 'skipped') job.skipCount++;
  };
  if (prev !== next) recount(prev, next);

  if (patch.error) t.error = String(patch.error).slice(0, 300);
  update(job);
}

function markCompleted(job, report = {}) {
  job.state = STATES.COMPLETED;
  job.finishedAt = new Date().toISOString();
  if (typeof report.success === 'number') job.successCount = report.success;
  if (typeof report.fail === 'number') job.failCount = report.fail;
  if (typeof report.skip === 'number') job.skipCount = report.skip;
  update(job);
}

function markInterrupted(job) {
  job.state = STATES.INTERRUPTED;
  update(job);
}

function markCancelled(job) {
  job.state = STATES.CANCELLED;
  job.finishedAt = new Date().toISOString();
  update(job);
}

function list() {
  try {
    return fs
      .readdirSync(JOBS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf-8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listActive() {
  return list().filter((j) => j.state === STATES.RUNNING || j.state === STATES.INTERRUPTED);
}

/** Mark all 'running' jobs as 'interrupted' (process died while running). */
function recoverInterrupted() {
  const recovered = [];
  for (const job of listActive()) {
    if (job.state === STATES.RUNNING) {
      markInterrupted(job);
      recovered.push(job);
    }
  }
  return recovered;
}

/** Delete the job file and its media directory. */
function deleteJob(job) {
  try {
    fs.removeSync(fileFor(job.id));
  } catch {}
  try {
    fs.removeSync(path.join(JOBS_DIR, job.id));
  } catch {}
}

/** Reset store (used by tests). */
function _reset() {
  try {
    fs.removeSync(JOBS_DIR);
    fs.ensureDirSync(JOBS_DIR);
  } catch {}
}

module.exports = {
  STATES,
  TARGET_STATUS,
  create,
  read,
  update,
  updateTarget,
  markCompleted,
  markInterrupted,
  markCancelled,
  list,
  listActive,
  recoverInterrupted,
  deleteJob,
  _reset,
};
