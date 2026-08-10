/**
 * contactBrowser — paginated Telegram inline-keyboard for the contact
 * manager (📒 Kontaktlar): browse the internal contact database, open a
 * contact and pick an action (rename / change number / delete / view).
 *
 * Callback-data namespace: `ct:`.
 */
const { formatPhone } = require('./azPhone');

const CONTACTS_PER_PAGE = 5;

function waBadge(contact) {
  if (contact.waRegistered === 'yes') return '✅';
  if (contact.waRegistered === 'no') return '⚠️';
  return '—';
}

/**
 * @param {object[]} contacts — sorted list from contactStore.list()
 * @param {number} page — 0-based
 * @returns {{text: string, keyboard: object[][]}}
 */
function buildContactList(contacts, page = 0) {
  const total = contacts.length;
  const pages = Math.max(1, Math.ceil(total / CONTACTS_PER_PAGE));
  const cur = Math.min(Math.max(page, 0), pages - 1);
  const slice = contacts.slice(cur * CONTACTS_PER_PAGE, (cur + 1) * CONTACTS_PER_PAGE);

  const keyboard = [];
  for (const c of slice) {
    keyboard.push([
      {
        text: `👤 ${c.name} — ${formatPhone(c.phone)} ${waBadge(c)}`,
        callback_data: `ct:view:${c.phone}`,
      },
    ]);
  }
  keyboard.push([
    { text: '⬅️', callback_data: cur > 0 ? `ct:page:${cur - 1}` : 'ct:noop' },
    { text: `${cur + 1}/${pages}`, callback_data: 'ct:noop' },
    { text: '➡️', callback_data: cur < pages - 1 ? `ct:page:${cur + 1}` : 'ct:noop' },
  ]);
  keyboard.push([{ text: '🔍 Axtar (ad / nömrə)', callback_data: 'ct:search' }]);
  keyboard.push([{ text: '↩️ Geri', callback_data: 'ct:back' }]);

  return {
    text:
      `📒 Kontaktlar (${total})\n` +
      `Səhifə ${cur + 1}/${pages}\n\n` +
      (total === 0
        ? 'Baza boşdur. `.rr` ilə kontakt əlavə edin.'
        : 'Kontakta toxunun:'),
    keyboard,
  };
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  try {
    return d.toLocaleString('az');
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * @param {object} contact — contactStore entry
 * @returns {{text: string, keyboard: object[][]}}
 */
function buildContactActions(contact) {
  const keyboard = [
    [
      { text: '✏️ Ad', callback_data: `ct:rename:${contact.phone}` },
      { text: '🔢 Nömrə', callback_data: `ct:num:${contact.phone}` },
    ],
    [
      { text: '🗑 Sil', callback_data: `ct:del:${contact.phone}` },
      { text: '👁 Məlumat', callback_data: `ct:view:${contact.phone}` },
    ],
    [{ text: '↩️ Geri', callback_data: 'ct:back' }],
  ];

  return {
    text:
      `👤 ${contact.name}\n` +
      `📱 ${formatPhone(contact.phone)}\n` +
      `📡 WhatsApp: ${waBadge(contact)}\n` +
      `➕ Əlavə edildi: ${fmtDate(contact.addedAt)}\n` +
      `🔄 Yeniləndi: ${fmtDate(contact.updatedAt)}`,
    keyboard,
  };
}

/** Human-readable contact details (👁 Məlumat screen). */
function buildContactInfo(contact) {
  return (
    `👁 ${contact.name}\n\n` +
    `📱 ${formatPhone(contact.phone)}\n` +
    `📡 WhatsApp: ${waBadge(contact)}\n` +
    `➕ Əlavə edildi: ${fmtDate(contact.addedAt)}\n` +
    `🔄 Son yenilənmə: ${fmtDate(contact.updatedAt)}\n` +
    `🆔 ${contact.phone}`
  );
}

module.exports = { buildContactList, buildContactActions, buildContactInfo, CONTACTS_PER_PAGE };
