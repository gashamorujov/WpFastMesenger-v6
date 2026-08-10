/**
 * ContactService — the .rr pipeline: validate → deduplicate → store →
 * mirror to WhatsApp contacts.
 *
 * Every contact is ALWAYS stored in the bot's own persistent directory
 * (modules/contactStore) — that is the source of truth for the .ss contact
 * picker and prevents duplicates. When a WhatsApp socket is connected, the
 * contact is additionally pushed to WhatsApp's own contact list via the
 * official linked-device contactAction patch (modules/waPresence).
 *
 * One failure never stops the queue: each adapter call is isolated and
 * returns a structured result.
 */
const waPresence = require('./waPresence');
const contactStore = require('./contactStore');
const wa = require('./whatsappManager');
const { makeLogger } = require('./logger');

const LOG = makeLogger('CONTACTS');

/**
 * Add one contact (name + phone, phone normalized by the caller).
 *
 * @param {{name: string, phone: string}} contact
 * @returns {Promise<{status: 'added'|'updated'|'duplicate'|'stored'|'failed', reason?: string, waRegistered?: boolean|null}>}
 */
async function addContact(contact) {
  try {
    // 1) Persist locally (dedup by normalized phone; update name when changed)
    const saved = contactStore.upsert(contact);
    if (!saved) {
      return { status: 'failed', reason: 'Yanlış kontakt məlumatı (ad və ya nömrə yoxdur)' };
    }

    // 2) Check WhatsApp registration (best-effort, cached)
    let waRegistered = null;
    const sender = wa.getSenderSocket();
    if (sender && sender.sock) {
      try {
        const map = await waPresence.checkRegistered(sender.sock, [saved.contact.phone]);
        waRegistered = map.get(saved.contact.phone) ?? null;
        contactStore.setWaStatus(saved.contact.phone, waRegistered === true ? 'yes' : waRegistered === false ? 'no' : 'unknown');
      } catch (e) {
        LOG.warn('Presence check failed:', e.message);
      }
    }

    // 3) Mirror to WhatsApp contact list
    if (sender && sender.sock) {
      const res = await waPresence.addContactToWhatsApp(sender.sock, {
        name: saved.contact.name,
        phone: saved.contact.phone,
      });
      if (res.ok) {
        return { status: saved.created ? 'added' : saved.updated ? 'updated' : 'duplicate', waRegistered };
      }
      return { status: saved.created ? 'stored' : saved.updated ? 'stored' : 'duplicate', reason: res.reason, waRegistered };
    }

    // No active WhatsApp connection — contact is safely stored locally.
    return {
      status: saved.created ? 'stored' : saved.updated ? 'stored' : 'duplicate',
      reason: 'WhatsApp bağlantısı aktiv deyil — kontakt daxili bazada saxlanıldı',
      waRegistered,
    };
  } catch (e) {
    LOG.error('Contact add error:', e.message);
    return { status: 'failed', reason: e.message };
  }
}


/**
 * Database-dəki BÜTÜN kontaktları WhatsApp kontaktlarına əlavə edir.
 * Mövcud kontakt əlavə etmə mexanizmindən (addOrEditContact) istifadə olunur;
 * bir kontaktın xətası digərlərini dayandırmaz.
 *
 * @returns {Promise<{ok: boolean, reason?: string, total: number, okCount: number, failed: Array<{phone: string, name: string, reason: string}>}>}
 */
async function syncAllToWhatsApp() {
  const contacts = contactStore.list();
  const sender = wa.getSenderSocket();
  if (!sender || !sender.sock || typeof sender.sock.addOrEditContact !== 'function') {
    return {
      ok: false,
      reason: 'Aktiv WhatsApp bağlantısı yoxdur və ya kontakt sinxronizasiyası dəstəklənmir',
      total: contacts.length,
      okCount: 0,
      failed: [],
    };
  }

  let okCount = 0;
  const failed = [];
  for (const c of contacts) {
    try {
      const res = await waPresence.addContactToWhatsApp(sender.sock, { name: c.name, phone: c.phone });
      if (res.ok) okCount++;
      else failed.push({ phone: c.phone, name: c.name, reason: res.reason || 'Bilinməyən xəta' });
    } catch (e) {
      failed.push({ phone: c.phone, name: c.name, reason: e.message || 'Bilinməyən xəta' });
    }
  }

  return { ok: true, total: contacts.length, okCount, failed };
}

module.exports = { addContact, syncAllToWhatsApp };
