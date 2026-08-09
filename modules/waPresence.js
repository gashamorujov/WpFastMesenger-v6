/**
 * waPresence — WhatsApp account-level operations on a connected socket.
 *
 * Two official WhatsApp Web (linked device) protocol capabilities:
 *
 *  1. checkRegistered(phones)  — uses the USync query (sock.onWhatsApp) to
 *     ask WhatsApp's server whether numbers are registered on WhatsApp.
 *
 *  2. addContactToWhatsApp(...) — uses the app-state contactAction patch
 *     (sock.addOrEditContact) — the exact mechanism WhatsApp Web itself uses
 *     when you add/edit a contact from a linked device. The contact is saved
 *     into WhatsApp's own contact list (NOT the phone's native address book).
 *
 * Both are public, documented Baileys socket APIs; no scraping or private
 * endpoints are used.
 */
const { makeLogger } = require('./logger');
const { normalizePhone } = require('../lib/phone');

const LOG = makeLogger('WA-PRESENCE');

const CHECK_CHUNK_SIZE = 20;
const QUERY_TIMEOUT_MS = 30000;
const CACHE_TTL_MS = 30 * 60 * 1000;

/** phone -> { exists: boolean, checkedAt: number } */
const presenceCache = new Map();

function cacheGet(phone) {
  const hit = presenceCache.get(phone);
  if (!hit) return undefined;
  if (Date.now() - hit.checkedAt > CACHE_TTL_MS) {
    presenceCache.delete(phone);
    return undefined;
  }
  return hit;
}

function cacheSet(phone, exists) {
  presenceCache.set(phone, { exists, checkedAt: Date.now() });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * Check whether phones are registered on WhatsApp (server-side USync query).
 * @param {object} sock — Baileys socket
 * @param {string[]} phones — normalized numbers
 * @param {object} [opts]
 * @param {(phone: string, exists: boolean|null) => void} [opts.onResult]
 * @returns {Promise<Map<string, boolean|null>>} phone -> exists (null = unknown)
 */
async function checkRegistered(sock, phones, opts = {}) {
  const result = new Map();
  if (!sock || typeof sock.onWhatsApp !== 'function') {
    for (const p of phones) result.set(p, null);
    return result;
  }

  const fresh = phones.filter((p) => !cacheGet(p));
  const chunked = [];
  for (let i = 0; i < fresh.length; i += CHECK_CHUNK_SIZE) {
    chunked.push(fresh.slice(i, i + CHECK_CHUNK_SIZE));
  }

  for (const chunk of chunked) {
    if (chunk.length === 0) continue;
    try {
      const res = await withTimeout(sock.onWhatsApp(...chunk), QUERY_TIMEOUT_MS);
      const byJid = new Map((res || []).map((r) => [String(r.jid || ''), r.exists]));
      for (const phone of chunk) {
        const exists = byJid.get(`${phone}@s.whatsapp.net`) ?? null;
        if (exists !== null) cacheSet(phone, exists);
        if (opts.onResult) {
          try { opts.onResult(phone, exists); } catch {}
        }
      }
    } catch (e) {
      LOG.warn(`onWhatsApp check failed for chunk of ${chunk.length}:`, e.message);
      for (const phone of chunk) {
        if (opts.onResult) {
          try { opts.onResult(phone, null); } catch {}
        }
      }
    }
  }

  for (const p of phones) {
    const hit = cacheGet(p);
    result.set(p, hit ? hit.exists : null);
  }
  return result;
}

/**
 * Save a contact (name + phone) into WhatsApp's contact list using the
 * official linked-device contactAction patch.
 *
 * @param {object} sock — Baileys socket
 * @param {{name: string, phone: string}} contact
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function addContactToWhatsApp(sock, contact) {
  const phone = normalizePhone(contact.phone);
  const name = String(contact.name || '').trim();
  if (!sock || typeof sock.addOrEditContact !== 'function') {
    return { ok: false, reason: 'WhatsApp bağlantısı yoxdur və ya kontakt sinxronizasiyası dəstəklənmir' };
  }
  if (!phone || !name) return { ok: false, reason: 'Yanlış kontakt məlumatı' };

  const jid = `${phone}@s.whatsapp.net`;
  const parts = name.split(/\s+/);

  try {
    await withTimeout(
      sock.addOrEditContact(jid, {
        fullName: name,
        firstName: parts[0] || name,
        username: '',
        saveOnPrimaryAddressbook: false, // WhatsApp kontaktlarında saxla (telefon kitabçasına yazma)
      }),
      QUERY_TIMEOUT_MS
    );
    return { ok: true };
  } catch (e) {
    LOG.warn(`addOrEditContact failed for +${phone}:`, e.message);
    return { ok: false, reason: e.message };
  }
}

/** Clear the presence cache (used by tests). */
function _resetCache() {
  presenceCache.clear();
}

module.exports = { checkRegistered, addContactToWhatsApp, _resetCache };
