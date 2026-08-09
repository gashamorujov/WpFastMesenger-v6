/**
 * ContactStore — persistent contact directory (data/contacts.json).
 *
 * This is the bot's own contact database. Every .rr contact is stored here
 * (normalized phone as the unique key) and mirrored to WhatsApp's contact
 * list through the linked-device contact-sync action when a socket is
 * connected. Upsert semantics prevent duplicate contacts: an existing phone
 * is updated with the new name instead of creating a second entry.
 */
const fs = require('fs-extra');
const path = require('path');
const { makeLogger } = require('./logger');
const { normalizePhone, cleanName, validateName } = require('../lib/phone');

const LOG = makeLogger('CONTACT-STORE');

const DATA_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'contacts.json');

fs.ensureDirSync(DATA_DIR);

let contacts = [];
let loaded = false;
let dirty = false;

function load() {
  if (loaded) return contacts;
  loaded = true;
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
      contacts = Array.isArray(data.contacts) ? data.contacts : [];
    }
  } catch (e) {
    LOG.error('Load contacts failed:', e.message);
    contacts = [];
  }
  return contacts;
}

function save() {
  if (!loaded) return;
  try {
    const payload = JSON.stringify({ contacts, savedAt: new Date().toISOString() }, null, 2);
    fs.writeFileSync(FILE, payload);
    dirty = false;
  } catch (e) {
    LOG.error('Save contacts failed:', e.message);
  }
}

function persistSoon() {
  dirty = true;
  // Synchronous write is fine for this scale; keep it immediate so a crash
  // never loses recently added contacts.
  save();
}

/**
 * Upsert a contact by normalized phone.
 * @param {{name: string, phone: string}} input
 * @returns {{contact: object, created: boolean, updated: boolean, duplicate: boolean}}
 */
function upsert(input) {
  const phone = normalizePhone(input.phone);
  const name = cleanName(input.name);
  if (!phone || !name) return null;

  load();
  const now = new Date().toISOString();
  const idx = contacts.findIndex((c) => c.phone === phone);

  if (idx === -1) {
    const contact = { phone, name, waRegistered: null, waCheckedAt: null, addedAt: now, updatedAt: now };
    contacts.push(contact);
    persistSoon();
    return { contact, created: true, updated: false, duplicate: false };
  }

  const existing = contacts[idx];
  const duplicate = existing.name === name;
  if (!duplicate) {
    existing.name = name;
    existing.updatedAt = now;
    persistSoon();
  }
  return { contact: existing, created: false, updated: !duplicate, duplicate };
}

/**
 * @param {string} phone — any format (normalized internally)
 * @returns {object|null}
 */
function get(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  load();
  return contacts.find((c) => c.phone === normalized) || null;
}

/** @returns {object[]} all contacts sorted by name. */
function list() {
  load();
  return [...contacts].sort((a, b) => a.name.localeCompare(b.name, 'az'));
}

function count() {
  load();
  return contacts.length;
}

/** Cache the WhatsApp-registration status for a phone. */
function setWaStatus(phone, status) {
  const c = get(phone);
  if (!c) return;
  c.waRegistered = status; // 'yes' | 'no' | 'unknown' | null
  c.waCheckedAt = new Date().toISOString();
  persistSoon();
}

/**
 * @param {string} query — free text search over name/phone
 * @returns {object[]}
 */
function search(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list();
  const digits = q.replace(/\D/g, '');
  return list().filter((c) => {
    if (digits && (c.phone.includes(digits) || c.phone.replace(/^994/, '0').includes(digits))) return true;
    return c.name.toLowerCase().includes(q);
  });
}

function remove(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  load();
  const before = contacts.length;
  contacts = contacts.filter((c) => c.phone !== normalized);
  if (contacts.length !== before) {
    persistSoon();
    return true;
  }
  return false;
}

/**
 * Change a contact's phone number. Rejects when the new number is invalid
 * or already used by ANOTHER contact (duplicate prevention).
 * @param {string} oldPhone — any format
 * @param {string} newPhone — any format
 * @returns {{ok: boolean, reason?: string, contact?: object}}
 */
function changePhone(oldPhone, newPhone) {
  const oldP = normalizePhone(oldPhone);
  const newP = normalizePhone(newPhone);
  if (!oldP || !newP) return { ok: false, reason: 'Yanlış nömrə formatı' };
  load();
  const idx = contacts.findIndex((c) => c.phone === oldP);
  if (idx === -1) return { ok: false, reason: 'Kontakt tapılmadı' };
  const conflict = contacts.find((c) => c.phone === newP);
  if (conflict) return { ok: false, reason: `Bu nömrə artıq "${conflict.name}" kontaktında mövcuddur (duplicate icazə verilmir)` };
  contacts[idx].phone = newP;
  contacts[idx].updatedAt = new Date().toISOString();
  persistSoon();
  return { ok: true, contact: contacts[idx] };
}

/** Update a contact's name (empty/invalid rejected). */
function updateName(phone, name) {
  const check = validateName(name);
  if (!check.ok) return { ok: false, reason: check.reason };
  return upsert({ phone, name: check.name });
}

/** Reset store (used by tests). */
function _reset() {
  contacts = [];
  loaded = false;
  dirty = false;
  try { fs.removeSync(FILE); } catch {}
}

module.exports = { upsert, get, list, count, search, remove, setWaStatus, changePhone, updateName, _reset };
