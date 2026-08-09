/**
 * .ss — send a message/media to a list of numbers (bulk message).
 *
 * Flow:
 *   1. `.ss` → bot shows the target prompt (buttons: contact picker / manual)
 *   2. targets are collected from saved contacts (paginated picker with
 *      Select All / Deselect All) and/or typed numbers
 *   3. user sends text / image / video / audio / voice / sticker / GIF /
 *      file / PDF / caption media — the original format is preserved
 *   4. a persistent job is created (modules/broadcastService + jobStore):
 *      sequential sends, per-target status, live progress, WhatsApp
 *      registration pre-check, duplicate guard, retry of failures
 *   5. final report with failed/skipped lists + retry button
 *
 * `.cc` cancels at any stage (a running job is cancelled, never resumed).
 */
const fs = require('fs-extra');
const { parseNumbers } = require('../lib/phone');
const { isNumbersOnly } = require('../modules/commandParser');
const { sessionManager } = require('../modules/services');
const { STATES } = require('../modules/sessionManager');
const { buildPicker, selectionSummary } = require('../lib/picker');
const contactStore = require('../modules/contactStore');
const recentSends = require('../modules/recentSends');
const broadcastService = require('../modules/broadcastService');
const jobStore = require('../modules/jobStore');
const { specFromBuilt } = require('../lib/telegramPayload');
const { formatPhone } = require('../lib/azPhone');
const { SS_START_BUTTONS, MAIN_MENU_BUTTONS } = require('../lib/menu');
const wa = require('../modules/whatsappManager');

const NUMBER_PROMPT =
  'Mesaj göndəriləcək nömrələri seçin və ya göndərin.\n\n' +
  '📇 Kontaktlardan seçin — butonla\n' +
  '✏️ Əl ilə: hər nömrə ayrıca sətirdə\n\n' +
  'Nümunə:\n' +
  '0501234567\n0512345678\n0553456789\n\n' +
  'Prosesi ləğv etmək üçün:\n.cc';

const DONE_PROMPT =
  'İndi göndərmək istədiyiniz mesajı və ya medianı göndərin.\n' +
  'Mətn, şəkil, video, səs, stiker, fayl — istənilən format.\n' +
  'Sonda yenidən nömrələr göndərə bilərsiniz (əlavə olunur).\n\n' +
  'Ləğv etmək üçün:\n.cc';

/**
 * @param {string} chatId
 * @param {(text: string, opts?: object) => Promise<any>} send
 * @param {string} [arg] — `.ss c` opens the contact picker directly
 */
async function start(chatId, send, arg) {
  sessionManager.cancel(chatId);
  const s = sessionManager.get(chatId);
  s.state = STATES.SS_NUMBERS;
  s.aborted = false;
  s.numbers = [];
  sessionManager.touch(chatId);

  if (send) {
    if (arg && (arg === 'c' || arg === 'k' || arg === 'pick')) {
      await openPicker(chatId, send);
      return;
    }
    await send(NUMBER_PROMPT, { reply_markup: { inline_keyboard: SS_START_BUTTONS } });
  }
}

// ─── Contact picker ───

async function openPicker(chatId, send, edit) {
  const s = sessionManager.get(chatId);
  s.state = STATES.SS_NUMBERS;
  const contacts = contactStore.list();
  const selected = new Set(s.numbers.map((n) => n.phone));
  const { text, keyboard } = buildPicker(contacts, selected, s.picker.page || 0);
  const opts = { reply_markup: { inline_keyboard: keyboard } };
  if (edit && s.pickerMsgId) {
    await edit(chatId, s.pickerMsgId, text, opts);
  } else if (send) {
    const sent = await send(text, opts);
    if (sent?.message_id) s.pickerMsgId = sent.message_id;
  }
  return true;
}

async function renderPicker(chatId, edit) {
  const s = sessionManager.get(chatId);
  const contacts = contactStore.list();
  const selected = new Set(s.numbers.map((n) => n.phone));
  const { text, keyboard } = buildPicker(contacts, selected, s.picker.page || 0);
  if (edit && s.pickerMsgId) {
    await edit(chatId, s.pickerMsgId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await openPicker(chatId, null, edit);
  }
}

/**
 * Handle contact-picker callback actions (`sp:*`).
 * @param {string} chatId
 * @param {string} action — e.g. 'toggle:994501234567'
 * @param {object} send
 * @param {object} edit — (chatId, messageId, text, opts) => Promise
 */
async function pickerAction(chatId, action, send, edit) {
  const s = sessionManager.get(chatId);
  if (!s || !action) return false;
  sessionManager.touch(chatId);

  const [cmd, payload] = action.split(':');

  if (cmd === 'start') {
    return openPicker(chatId, send, edit);
  }

  if (cmd === 'toggle') {
    const phone = payload;
    const idx = s.numbers.findIndex((n) => n.phone === phone);
    if (idx >= 0) {
      s.numbers.splice(idx, 1);
    } else {
      const contact = contactStore.get(phone);
      s.numbers.push({ phone, name: contact ? contact.name : null });
    }
    await renderPicker(chatId, edit);
    return true;
  }

  if (cmd === 'all') {
    const contacts = contactStore.list();
    const existing = new Set(s.numbers.map((n) => n.phone));
    for (const c of contacts) {
      if (!existing.has(c.phone)) s.numbers.push({ phone: c.phone, name: c.name });
    }
    await renderPicker(chatId, edit);
    return true;
  }

  if (cmd === 'none') {
    s.numbers.length = 0;
    await renderPicker(chatId, edit);
    return true;
  }

  if (cmd === 'page') {
    s.picker.page = parseInt(payload, 10) || 0;
    await renderPicker(chatId, edit);
    return true;
  }

  if (cmd === 'manual') {
    s.pickerMsgId = null;
    s.state = STATES.SS_NUMBERS;
    await send(NUMBER_PROMPT);
    return true;
  }

  if (cmd === 'done') {
    if (s.numbers.length === 0) {
      await send('❌ Heç bir nömrə seçilməyib. Kontaktlara toxunaraq seçin və ya əl ilə daxil edin.');
      return true;
    }
    s.state = STATES.SS_CONTENT;
    s.pickerMsgId = null;
    await send(
      `${selectionSummary(s.numbers)}\n\n${DONE_PROMPT}`,
      { reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS } }
    );
    return true;
  }

  if (cmd === 'retry') {
    const jobId = payload;
    const old = jobStore.read(jobId);
    if (!old || String(old.chatId) !== String(chatId)) {
      await send('❌ İş tapılmadı və ya artıq silinib.');
      return true;
    }
    const newJob = broadcastService.retryFailed(jobId);
    if (!newJob) {
      await send('❌ Yenidən cəhd üçün xəta olan nömrə yoxdur.');
      return true;
    }
    await send(`🔁 ${newJob.targets.length} uğursuz nömrəyə yenidən göndərilir...`);
    return true;
  }

  return false;
}

// ─── Content / numbers handling ───

/**
 * @param {string} chatId
 * @param {object} msg — raw message content (platform-specific)
 * @param {string} text
 * @param {(text: string, opts?: object) => Promise<any>} send
 * @param {(msg: object) => Promise<{type: string, payload: object|null, tempFile?: string, reason?: string}>} buildPayload
 */
async function handle(chatId, msg, text, send, buildPayload) {
  const s = sessionManager.get(chatId);
  if (s.state !== STATES.SS_NUMBERS && s.state !== STATES.SS_CONTENT) return false;
  sessionManager.touch(chatId);

  if (!send || !buildPayload) return true;

  // ── Numbers phase ──
  if (s.state === STATES.SS_NUMBERS) {
    if (!text || !isNumbersOnly(text)) {
      await send(
        '❌ Yalnız nömrələr göndərin və ya 📇 Kontaktlardan seçin.\nFormat: hər sətirdə bir nömrə, məsələn 0501234567.\n' +
          'İstəyirsinizsə .cc ilə ləğv edin.',
        { reply_markup: { inline_keyboard: SS_START_BUTTONS } }
      );
      return true;
    }

    const { numbers, errors } = parseNumbers(text);
    const existing = new Set(s.numbers.map((n) => n.phone));
    const fresh = numbers.filter((n) => !existing.has(n));
    for (const n of fresh) s.numbers.push({ phone: n, name: null });

    const lines = [];
    if (fresh.length > 0) lines.push(`✔ ${fresh.length} nömrə yadda saxlanıldı.`);
    if (errors.length > 0) {
      lines.push(`⚠️ ${errors.length} nömrə yanlışdır:`);
      for (const e of errors.slice(0, 10)) lines.push(`• Sətir ${e.line}: ${e.reason}`);
    }

    const recent = fresh.filter((n) => recentSends.isRecent(n));
    if (recent.length > 0) {
      lines.push(`⚠️ ${recent.length} nömrə yaxın vaxtda artıq göndərilib (avtomatik atlanacaq):`);
      for (const r of recent.slice(0, 5)) lines.push(`• ${formatPhone(r)}`);
    }

    if (fresh.length === 0) {
      lines.push('', 'Düzəliş edib yenidən göndərin.');
      await send(lines.join('\n'));
      return true;
    }

    lines.push('', `Toplam: ${s.numbers.length} nömrə.`);
    lines.push('', DONE_PROMPT);
    s.state = STATES.SS_CONTENT;
    await send(lines.join('\n'));
    return true;
  }

  // ── Content phase ──
  // More numbers can still be appended
  if (text && isNumbersOnly(text)) {
    const { numbers, errors } = parseNumbers(text);
    const existing = new Set(s.numbers.map((n) => n.phone));
    const fresh = numbers.filter((n) => !existing.has(n));
    for (const n of fresh) s.numbers.push({ phone: n, name: null });

    const lines = [`✔ ${fresh.length} nömrə əlavə edildi.`, `Toplam: ${s.numbers.length} nömrə.`];
    if (errors.length > 0) {
      lines.push(`⚠️ ${errors.length} sətir yanlışdır və nəzərə alınmadı.`);
    }
    if (fresh.length > 0) {
      lines.push('', 'İndi göndəriləcək mesajı göndərin.');
    }
    await send(lines.join('\n'));
    return true;
  }

  if (s.numbers.length === 0) {
    await send('❌ Nömrə yoxdur. Yenidən .ss yazın.');
    sessionManager.reset(chatId);
    return true;
  }

  // Build the WhatsApp payload from the received message (format preserved)
  const built = await buildPayload(msg);
  if (!built.payload) {
    await send(`❌ ${built.reason || 'Bu mesaj növü dəstəklənmir.'}`);
    return true;
  }

  // The broadcast needs a live WhatsApp connection to start (it can still be
  // resumed later if the connection drops mid-job).
  const sender = wa.getSenderSocket();
  if (!sender || !sender.sock) {
    await send('❌ Aktiv WhatsApp bağlantısı yoxdur. Əvvəlcə paneldən Pair Code ilə qoşulun.');
    if (built.tempFile) {
      try { fs.removeSync(built.tempFile); } catch {}
    }
    return true;
  }

  s.contentCount++;

  const sent = await send(
    `🚀 ${built.type.toUpperCase()} ${s.numbers.length} nömrəyə göndərilir...\n` +
      'Göndərişlər ardıcıldır və WhatsApp limitlərinə uyğun sürətdədir.\n' +
      '❌ .cc ilə ləğv edə bilərsiniz.'
  );
  const progressMsgId = sent?.message_id || null;

  const spec = specFromBuilt(built);
  const job = broadcastService.createJob({
    chatId,
    type: built.type,
    payloadSpec: spec,
    targets: s.numbers.map((n) => ({ phone: n.phone, name: n.name })),
    progressMsgId,
    tempFile: built.tempFile || null,
  });

  if (job) {
    // Keep the session numbers so more content messages can be queued for
    // the same list; the cross-job duplicate guard prevents accidental
    // re-sends to the same number within the configured TTL.
    s.state = STATES.SS_CONTENT;
    sessionManager.touch(chatId);
  }
  return true;
}

module.exports = { start, handle, pickerAction };
