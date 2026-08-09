/**
 * RecentSends — cross-job duplicate-send guard (keyed by payload).
 *
 * Records { phone → { ts, key } } for every bulk message sent
 * (data/recent-sends.json). A phone is only blocked when the SAME payload
 * (message text / media identity) was sent within the TTL — so sending two
 * different messages to the same list stays possible, while accidentally
 * re-sending the exact same message is prevented.
 *
 * TTL: DUPLICATE_SEND_TTL_MIN (default 10 min; 0 disables the guard).
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { makeLogger } = require('./logger');
const { normalizePhone } = require('../lib/phone');

const LOG = makeLogger('RECENT-SENDS');

const DATA_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'recent-sends.json');

const TTL_MS = (parseInt(process.env.DUPLICATE_SEND_TTL_MIN, 10) || 10) * 60 * 1000;

let sends = {};
let loaded = false;

function load() {
  if (loaded) return sends;
  loaded = true;
  try {
    if (fs.existsSync(FILE)) sends = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    sends = {};
  }
  return sends;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(sends));
  } catch (e) {
    LOG.error('Save recent-sends failed:', e.message);
  }
}

/**
 * @param {string} phone — any format
 * @param {string} payloadKey — stable identity of the message content
 */
function markSent(phone, payloadKey = '') {
  if (TTL_MS <= 0) return;
  const p = normalizePhone(phone);
  if (!p) return;
  load();
  sends[p] = { ts: Date.now(), key: String(payloadKey || '') };
  save();
}

/** True when the SAME message content was sent to this phone within TTL. */
function isDuplicate(phone, payloadKey = '') {
  if (TTL_MS <= 0) return false;
  const p = normalizePhone(phone);
  if (!p) return false;
  load();
  const rec = sends[p];
  if (!rec) return false;
  if (Date.now() - rec.ts >= TTL_MS) return false;
  return !payloadKey || rec.key === String(payloadKey);
}

/** True when ANY bulk message was sent to this phone within TTL (warnings). */
function isRecent(phone) {
  if (TTL_MS <= 0) return false;
  const p = normalizePhone(phone);
  if (!p) return false;
  load();
  const rec = sends[p];
  if (!rec) return false;
  return Date.now() - rec.ts < TTL_MS;
}

/** @returns {string[]} phones with a recent send (for .ss warnings). */
function recentPhones() {
  if (TTL_MS <= 0) return [];
  load();
  const now = Date.now();
  return Object.keys(sends).filter((p) => now - sends[p].ts < TTL_MS);
}

function _reset() {
  sends = {};
  loaded = false;
  try { fs.removeSync(FILE); } catch {}
}

module.exports = { markSent, isDuplicate, isRecent, recentPhones, TTL_MS, _reset };
