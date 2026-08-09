/**
 * .rr — register contacts (name + number) and save them to WhatsApp contacts.
 *
 * Flow:
 *   1. `.rr` → bot shows the format template
 *   2. user sends any number of name/number pairs (one or many messages)
 *   3. bot parses + validates (Azerbaijani numbers), reports bad lines,
 *      deduplicates against the session and the persistent contact store
 *   4. contacts are processed SEQUENTIALLY (queue) through the pluggable
 *      contact service: stored in the bot's contact directory AND mirrored
 *      to WhatsApp's own contact list (official contactAction sync) whenever
 *      a WhatsApp socket is connected
 *   5. final report: total / added to WA / updated / stored / duplicates /
 *      failures + numbers not registered on WhatsApp
 *
 * `.cc` cancels at any point.
 */
const { parseContacts } = require('../lib/phone');
const contactService = require('../modules/contactService');
const contactStore = require('../modules/contactStore');
const { Queue } = require('../modules/queue');
const { sessionManager } = require('../modules/services');
const { STATES } = require('../modules/sessionManager');
const { formatDuration } = require('../lib/broadcast');
const { formatPhone } = require('../lib/azPhone');
const { MAIN_MENU_BUTTONS } = require('../lib/menu');
const cleanup = require('../modules/messageCleanup');

const TEMPLATE =
  'Əlavə etmək istədiyiniz kontaktları aşağıdakı formada göndərin.\n\n' +
  'Ad Soyad\nNömrə\n\n' +
  'Ad Soyad\nNömrə\n\n' +
  '...\n\n' +
  'Dəstəklənən nömrə formatları:\n' +
  '+994501234567 • 994501234567 • 0501234567 • 050 123 45 67\n\n' +
  'Kontaktlar WhatsApp kontaktlarına əlavə olunur (yalnız WhatsApp-da, telefon kitabçasına yazılmır).\n' +
  'Artıq mövcud nömrə duplicate yaradılmadan yenilənir.\n\n' +
  'Prosesi ləğv etmək üçün:\n.cc';

/**
 * @param {string} chatId
 * @param {(text: string, opts?: object) => Promise<any>} send
 */
async function start(chatId, send) {
  sessionManager.cancel(chatId);
  const s = sessionManager.get(chatId);
  s.state = STATES.RR;
  s.aborted = false;
  s.contacts = [];
  sessionManager.touch(chatId);

  if (send) {
    const sent = await send(TEMPLATE);
    cleanup.track(chatId, sent?.message_id);
  }
}

async function ensureQueue(chatId, send) {
  const s = sessionManager.get(chatId);
  if (s.rrQueue) return s.rrQueue;

  s.rrResults = [];
  s.rrStart = Date.now();
  s.rrQueue = new Queue({
    onItem: async (contact) => {
      const result = await contactService.addContact(contact);
      s.rrResults.push({ contact, result });
    },
    delayMin: 800,
    delayMax: 1500,
    onStateChange: ({ busy }) => {
      if (busy || !send) return;
      if (s.aborted) {
        s.state = STATES.IDLE; // cancelled via .cc — no report
        return;
      }
      sendReport(chatId, send)
        .catch(() => {})
        .finally(() => {
          // Batch complete — auto-clean (same as .cc) so a new flow can start
          sessionManager.cancel(chatId);
        });
    },
  });
  return s.rrQueue;
}

async function sendReport(chatId, send) {
  const s = sessionManager.get(chatId);
  if (!s.rrResults || s.rrResults.length === 0) return;

  const results = s.rrResults;
  s.rrResults = [];

  const total = results.length;
  let added = 0;
  let updated = 0;
  let duplicate = 0;
  let stored = 0;
  let failed = 0;
  const failedList = [];
  const storedList = [];
  const notOnWaList = [];

  for (const { contact, result } of results) {
    switch (result.status) {
      case 'added':
        added++;
        break;
      case 'updated':
        updated++;
        break;
      case 'duplicate':
        duplicate++;
        break;
      case 'stored':
        stored++;
        storedList.push(`${contact.name} (+${formatPhone(contact.phone)})${result.reason ? ` — ${result.reason}` : ''}`);
        break;
      default:
        failed++;
        failedList.push(`${contact.name} (+${formatPhone(contact.phone)})${result.reason ? ` — ${result.reason}` : ''}`);
    }
    if (result.waRegistered === false) {
      notOnWaList.push(`${contact.name} (+${formatPhone(contact.phone)})`);
    }
  }

  const duration = formatDuration(Date.now() - (s.rrStart || Date.now()));

  const lines = [
    '✅ Kontakt emalı tamamlandı.',
    '',
    `Ümumi kontakt sayı: ${total}`,
    `📇 WhatsApp kontaktlarına əlavə edildi: ${added}`,
    `🔄 Yeniləndi (duplicate yaradılmadı): ${updated}`,
    `🗂 Duplicate (dəyişiklik yoxdur): ${duplicate}`,
    `💾 Yalnız daxili bazada saxlanıldı: ${stored}`,
    `❌ Xəta olanlar: ${failed}`,
    `Ümumi icra müddəti: ${duration}`,
  ];

  if (storedList.length > 0) {
    lines.push('', '⚠️ WhatsApp sinxronlaşdırılmayanlar (daxili bazada saxlanıldı):', ...storedList.slice(0, 10));
    if (storedList.length > 10) lines.push(`...və daha ${storedList.length - 10} nəfər`);
  }
  if (notOnWaList.length > 0) {
    lines.push('', '🔴 WhatsApp-da qeydiyyatda olmayanlar:', ...notOnWaList.slice(0, 10));
    if (notOnWaList.length > 10) lines.push(`...və daha ${notOnWaList.length - 10} nəfər`);
  }
  if (failedList.length > 0) {
    lines.push('', '❌ Xəta olanlar:', ...failedList.slice(0, 15));
    if (failedList.length > 15) lines.push(`...və daha ${failedList.length - 15} nəfər`);
  }

  lines.push('', `📒 Daxili bazada ümumi kontakt: ${contactStore.count()}`);

  await send(lines.join('\n'), { reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS } });

  // Əməliyyat bitdi — sorğu və ara mərhələ mesajlarını avtomatik sil
  await cleanup.deleteTracked(chatId);
}

/**
 * @param {string} chatId
 * @param {string} text
 * @param {(text: string, opts?: object) => Promise<any>} send
 */
async function handle(chatId, text, send) {
  const s = sessionManager.get(chatId);
  if (s.state !== STATES.RR) return false;
  sessionManager.touch(chatId);

  if (!send) return true;

  const { contacts, errors } = parseContacts(text);

  // Dedup against already-queued phones. A repeated phone with a DIFFERENT
  // name updates the pending entry (last input wins) instead of creating a
  // duplicate; a repeated phone with the same name is skipped entirely.
  const byPhone = new Map(s.contacts.map((c) => [c.phone, c]));
  const fresh = [];
  const renamed = [];
  for (const c of contacts) {
    const existing = byPhone.get(c.phone);
    if (!existing) {
      fresh.push(c);
      s.contacts.push(c);
    } else if (existing.name !== c.name) {
      existing.name = c.name;
      renamed.push({ ...c });
    }
  }

  const lines = [];
  if (fresh.length > 0) {
    lines.push(`✔ ${fresh.length} yeni kontakt qeydə alındı.`);
  }
  if (renamed.length > 0) {
    lines.push(`🔄 ${renamed.length} mövcud kontaktın adı yeniləndi.`);
  }
  if (errors.length > 0) {
    lines.push(`⚠️ ${errors.length} sətir yanlışdır və nəzərə alınmadı:`);
    for (const e of errors.slice(0, 15)) lines.push(`• Sətir ${e.line}: ${e.reason}`);
    if (errors.length > 15) lines.push(`...və daha ${errors.length - 15} sətir`);
  }

  if (fresh.length === 0 && renamed.length === 0) {
    if (errors.length === 0) {
      lines.push('⚠️ Nömrə tapılmadı. Format: Ad Soyad + nömrə.');
    }
    lines.push('', 'Düzəliş edib yenidən göndərin və ya .cc ilə ləğv edin.');
    const ackErr = await send(lines.join('\n'));
    cleanup.track(chatId, ackErr?.message_id);
    return true;
  }

  lines.push('', `Növbədə: ${s.contacts.length} kontakt. Ardıcıl emal başlayır...`);
  const ack = await send(lines.join('\n'));
  cleanup.track(chatId, ack?.message_id);

  // Enqueue — the queue worker processes one contact at a time
  const queue = await ensureQueue(chatId, send);
  for (const c of fresh) {
    queue.push(c);
  }
  for (const c of renamed) {
    queue.push(c);
  }
  return true;
}

module.exports = { start, handle };
