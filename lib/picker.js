/**
 * picker — paginated Telegram inline-keyboard contact picker for .ss.
 *
 * Callback-data namespace: `sp:` (kept short so every payload stays within
 * Telegram's 64-byte callback_data limit).
 *
 * Layout per page (max 8 rows):
 *   [✅ Hamısını seç] [⬜ Ləğv et]
 *   5 contact rows: toggle button (name + number + WA badge)
 *   [⬅️] [X/Y] [➡️]
 *   [✅ Davam et (N)] [✏️ Əl ilə daxil et]
 */
const { formatPhone } = require('./azPhone');

const CONTACTS_PER_PAGE = 5;

function waBadge(contact) {
  if (contact.waRegistered === 'yes') return ' 🟢';
  if (contact.waRegistered === 'no') return ' 🔴';
  return '';
}

/**
 * @param {object[]} contacts — from contactStore.list() (sorted)
 * @param {Set<string>} selected — normalized phones
 * @param {number} page — 0-based
 * @returns {{text: string, keyboard: object[][]}}
 */
function buildPicker(contacts, selected, page = 0) {
  const total = contacts.length;
  const pages = Math.max(1, Math.ceil(total / CONTACTS_PER_PAGE));
  const cur = Math.min(Math.max(page, 0), pages - 1);
  const slice = contacts.slice(cur * CONTACTS_PER_PAGE, (cur + 1) * CONTACTS_PER_PAGE);

  const keyboard = [];
  keyboard.push([
    { text: '✅ Hamısını seç', callback_data: 'sp:all' },
    { text: '⬜ Ləğv et', callback_data: 'sp:none' },
  ]);

  for (const c of slice) {
    const on = selected.has(c.phone);
    keyboard.push([
      {
        text: `${on ? '☑️' : '⬜'} ${c.name} — ${formatPhone(c.phone)}${waBadge(c)}`,
        callback_data: `sp:toggle:${c.phone}`,
      },
    ]);
  }

  keyboard.push([
    { text: '⬅️', callback_data: cur > 0 ? `sp:page:${cur - 1}` : 'sp:noop' },
    { text: `${cur + 1}/${pages}`, callback_data: 'sp:noop' },
    { text: '➡️', callback_data: cur < pages - 1 ? `sp:page:${cur + 1}` : 'sp:noop' },
  ]);

  keyboard.push([
    { text: `✅ Davam et (${selected.size})`, callback_data: 'sp:done' },
    { text: '✏️ Əl ilə daxil et', callback_data: 'sp:manual' },
  ]);

  return {
    text:
      `📇 Kontaktlardan seçin\n` +
      `Səhifə ${cur + 1}/${pages} • Seçilib: ${selected.size}\n\n` +
      (total === 0 ? 'Hələ heç bir kontakt əlavə edilməyib. `.rr` ilə kontakt əlavə edin və ya əl ilə daxil edin.' : 'Kontakta toxunaraq seçin/ləğv edin.'),
    keyboard,
  };
}

/** Human-readable summary of the selected numbers. */
function selectionSummary(numbers) {
  if (!numbers || numbers.length === 0) return 'Seçilmiş nömrə yoxdur.';
  const lines = numbers.map((n, i) => `${i + 1}. ${n.name ? n.name + ' — ' : ''}${formatPhone(n.phone)}`);
  return `Seçildi (${numbers.length}):\n${lines.join('\n')}`;
}

module.exports = { buildPicker, selectionSummary, CONTACTS_PER_PAGE };
