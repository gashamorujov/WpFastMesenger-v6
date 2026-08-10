/**
 * .ss — toplu mesaj: nömrələr (alt-alta) → mesaj → təsdiq → 🚀 Göndər.
 *
 * Axın:
 *   1. `.ss` → "📱 Nömrələri daxil edin:" (nömrələr alt-alta göstərilir)
 *   2. istənilən sayda nömrə — HƏR SƏTR AYRI NÖMRƏDİR (1, 10, 100+).
 *      Normalizə + duplicate sil + yanlışları göstər → "💬 Mesajı yaz:"
 *   3. mesaj/media → təsdiq ekranı: 📨 Hazırdır + [🚀 Göndər][✖️ Geri]
 *   4. 🚀 Göndər → persistent job; canlı progress + [🛑 Dayandır]
 *   5. Tamamlanma/ləğv → yekun nəticə ([🛑 Dayandır] silinir)
 *
 * Mesaj yerləşməsi: botun hər növbəti sorğu mesajı istifadəçinin SON
 * mesajından sonra — ən aşağıda — göndərilir. Keçmiş sorğu mesajları
 * avtomatik silinir (cleanup). Yalnız vacib yekun nəticə saxlanılır.
 *
 * Real göndərmə: hər nömrə üçün Baileys sendMessage çağırılır (lib/broadcast);
 * uğur yalnız WhatsApp client cavabından sonra ✅ hesab olunur. Xəta → ❌,
 * bir nömrənin xətası digərlərini dayandırmaz.
 */
const fs = require('fs-extra');
const { extractNumbers } = require('../lib/phone');
const { isNumbersOnly } = require('../modules/commandParser');
const { sessionManager } = require('../modules/services');
const { STATES } = require('../modules/sessionManager');
const contactStore = require('../modules/contactStore');
const recentSends = require('../modules/recentSends');
const broadcastService = require('../modules/broadcastService');
const { specFromBuilt } = require('../lib/telegramPayload');
const { formatPhone, toLocal } = require('../lib/azPhone');
const cleanup = require('../modules/messageCleanup');
const { SS_CONFIRM_BUTTONS, SS_STOP_BUTTONS, MENU_BUTTON } = require('../lib/menu');
const wa = require('../modules/whatsappManager');
const { makeLogger } = require('../modules/logger');

const LOG = makeLogger('SS');

const NUMBERS_PROMPT =
  '📱 Nömrələri daxil edin:\n\n' +
  '503482690\n' +
  '773971757\n' +
  '514143432\n\n' +
  'İstənilən sayda (1, 10, 100+).\n' +
  'Hər sətir ayrıca WhatsApp nömrəsidir.';
const CONTENT_PROMPT = '💬 Mesajı yaz:\n\nMətn və ya media (şəkil, video, səs, fayl).';

function previewText(built) {
  switch (built.type) {
    case 'text':
      return String(built.payload.text || '').replace(/\s+/g, ' ').slice(0, 200);
    case 'image':
      return `🖼 Şəkil${built.payload.caption ? ` — ${built.payload.caption.slice(0, 120)}` : ''}`;
    case 'video':
      return `🎬 Video${built.payload.caption ? ` — ${built.payload.caption.slice(0, 120)}` : ''}`;
    case 'video_note':
      return '🎥 Dairəvi video';
    case 'gif':
      return `🎞 GIF${built.payload.caption ? ` — ${built.payload.caption.slice(0, 120)}` : ''}`;
    case 'voice':
      return '🎙 Səs mesajı';
    case 'audio':
      return `🎵 Audio${built.payload.caption ? ` — ${built.payload.caption.slice(0, 120)}` : ''}`;
    case 'document':
      return `📄 ${built.payload.fileName || 'Fayl'}`;
    case 'sticker':
      return '😀 Stiker';
    case 'contact':
      return '📇 Kontakt kartı';
    case 'location':
      return '📍 Məkan';
    default:
      return built.type;
  }
}

/**
 * Cari flow mesajını (s.ssMsgId) redaktə edir; uğursuz olsa yenisini
 * göndərir. Yalnız təsdiq mesajının canlı progressə çevrilməsi üçün istifadə
 * olunur — həmin mesaj artıq ən aşağıdadır.
 */
async function editFlow(chatId, ctx, text, keyboard) {
  const s = sessionManager.get(chatId);
  const opts = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
  if (s.ssMsgId && ctx.edit) {
    try {
      await ctx.edit(text, opts);
      return true;
    } catch (e) {
      LOG.warn('editFlow edit failed, resending:', e.message);
    }
  }
  const sent = await ctx.send(text, opts);
  if (sent?.message_id) {
    s.ssMsgId = sent.message_id;
    cleanup.track(chatId, sent.message_id);
  }
  return true;
}

/**
 * Köhnə sorğu mesajlarını silir və YENİ sorğunu ən aşağıda — istifadəçinin
 * son mesajından SONRA — göndərir. Yeni mesaj izlənilir ki, növbəti mərhələdə
 * silinsin (yalnız yekun nəticə qalır).
 */
async function sendFlowMessage(chatId, ctx, text, keyboard) {
  await cleanup.deleteTracked(chatId);
  const sent = await ctx.send(text, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
  const s = sessionManager.get(chatId);
  if (sent?.message_id) {
    s.ssMsgId = sent.message_id;
    cleanup.track(chatId, sent.message_id);
  }
  return true;
}

/**
 * @param {string} chatId
 * @param {object} ctx — { send, edit, deleteMsg, messageId }
 */
async function start(chatId, ctx) {
  sessionManager.cancel(chatId);
  await cleanup.deleteTracked(chatId);
  const s = sessionManager.get(chatId);
  s.state = STATES.SS_NUMBERS;
  s.aborted = false;
  s.numbers = [];
  s.pendingPayload = null;
  sessionManager.touch(chatId);
  await sendFlowMessage(chatId, ctx, NUMBERS_PROMPT);
}

/**
 * Nömrələri alt-alta göstər: 0501234567 / 0551234567 / 0771234567 …
 * @param {string[]} phones — normalizə edilmiş (994…) nömrələr
 * @param {number} max — göstərilən maksimum say (qalanı "və daha N" olur)
 */
function numberLines(phones, max = 30) {
  const lines = phones.map((p) => toLocal(p) || p);
  if (lines.length > max) {
    return [...lines.slice(0, max), `...və daha ${lines.length - max} nömrə`];
  }
  return lines;
}

function numbersReport(numbers, duplicates, invalid, recent) {
  const lines = [`✔ ${numbers.length} nömrə qəbul edildi:`, '', ...numberLines(numbers)];
  if (duplicates.length > 0) {
    lines.push('', `🔁 ${duplicates.length} duplicate atlandı.`);
  }
  if (invalid.length > 0) {
    lines.push('', `⚠️ ${invalid.length} yanlış:`);
    for (const i of invalid.slice(0, 5)) lines.push(`• ${i}`);
    if (invalid.length > 5) lines.push(`...və daha ${invalid.length - 5}`);
  }
  if (recent.length > 0) {
    lines.push('', `⚠️ ${recent.length} yaxın vaxtda göndərilib (avtomatik atlanacaq):`);
    for (const r of recent.slice(0, 3)) lines.push(`• ${formatPhone(r)}`);
    if (recent.length > 3) lines.push(`...və daha ${recent.length - 3}`);
  }
  lines.push('', CONTENT_PROMPT);
  return lines.join('\n');
}

async function showConfirm(chatId, ctx) {
  const s = sessionManager.get(chatId);
  if (!s.pendingPayload || s.numbers.length === 0) return;
  const { built } = s.pendingPayload;
  const text =
    `📨 Hazırdır\n\n` +
    `👥 ${s.numbers.length} nömrə:\n\n` +
    `${numberLines(s.numbers.map((n) => n.phone)).join('\n')}\n\n` +
    `💬 ${previewText(built)}`;
  // Köhnə "Mesajı yaz" sorğusu silinir, təsdiq mesajı istifadəçinin
  // mesajından SONRA ən aşağıda yaradılır
  await sendFlowMessage(chatId, ctx, text, SS_CONFIRM_BUTTONS);
}

/**
 * Handle text/numbers/media messages.
 * @param {string} chatId
 * @param {object} msg
 * @param {string} text
 * @param {object} ctx — { send, edit, deleteMsg, messageId }
 * @param {(msg) => Promise<{type, payload, tempFile?, reason?}>} buildPayload
 */
async function handle(chatId, msg, text, ctx, buildPayload) {
  const s = sessionManager.get(chatId);
  if (s.state !== STATES.SS_NUMBERS && s.state !== STATES.SS_CONTENT) return false;
  sessionManager.touch(chatId);

  // ── Nömrələr mərhələsi ──
  if (s.state === STATES.SS_NUMBERS) {
    const { numbers, duplicates, invalid } = extractNumbers(text);
    if (numbers.length === 0) {
      await sendFlowMessage(chatId, ctx, `❌ Nömrə tapılmadı.\n\n${NUMBERS_PROMPT}`);
      return true;
    }

    const existing = new Set(s.numbers.map((n) => n.phone));
    const fresh = numbers.filter((n) => !existing.has(n));
    for (const n of fresh) s.numbers.push({ phone: n, name: null });

    const recent = fresh.filter((n) => recentSends.isRecent(n));
    s.state = STATES.SS_CONTENT;
    await sendFlowMessage(chatId, ctx, numbersReport(s.numbers.map((n) => n.phone), duplicates, invalid, recent));
    return true;
  }

  // ── Məzmun mərhələsi: daha çox nömrə əlavə oluna bilər ──
  if (text && isNumbersOnly(text)) {
    const { numbers, duplicates, invalid } = extractNumbers(text);
    const existing = new Set(s.numbers.map((n) => n.phone));
    const fresh = numbers.filter((n) => !existing.has(n));
    for (const n of fresh) s.numbers.push({ phone: n, name: null });
    const recent = fresh.filter((n) => recentSends.isRecent(n));
    if (fresh.length === 0) {
      await sendFlowMessage(chatId, ctx, `🔁 Yeni nömrə əlavə olunmadı (hamısı mövcuddur).\n\n👥 ${s.numbers.length} nömrə:\n\n${numberLines(s.numbers.map((n) => n.phone)).join('\n')}\n\n${CONTENT_PROMPT}`);
    } else {
      await sendFlowMessage(chatId, ctx, numbersReport(s.numbers.map((n) => n.phone), duplicates, invalid, recent));
    }
    return true;
  }

  if (s.numbers.length === 0) {
    await sendFlowMessage(chatId, ctx, `❌ Nömrə yoxdur. Yenidən .ss yazın.`, MENU_BUTTON);
    sessionManager.reset(chatId);
    return true;
  }

  // Build payload from the received message (format preserved)
  const built = await buildPayload(msg);
  if (!built.payload) {
    await sendFlowMessage(chatId, ctx, `❌ ${built.reason || 'Bu mesaj növü dəstəklənmir.'}`, MENU_BUTTON);
    return true;
  }

  const sender = wa.getSenderSocket();
  if (!sender || !sender.sock) {
    await sendFlowMessage(chatId, ctx, '❌ Aktiv WhatsApp bağlantısı yoxdur. Əvvəlcə 📲 Qoşul ilə qoşulun.', MENU_BUTTON);
    if (built.tempFile) {
      try { fs.removeSync(built.tempFile); } catch {}
    }
    return true;
  }

  // Payload təsdiqə qədər saxlanılır (🚀 Göndər / ✖️ Geri)
  s.pendingPayload = { built, spec: specFromBuilt(built) };
  s.contentCount++;
  s.state = STATES.SS_CONFIRM;
  await showConfirm(chatId, ctx);
  return true;
}

function cleanupPending(s) {
  if (s.pendingPayload?.built?.tempFile) {
    try { fs.removeSync(s.pendingPayload.built.tempFile); } catch {}
  }
  s.pendingPayload = null;
}

/**
 * Handle `sp:*` callbacks: 🚀 Göndər / ✖️ Geri / 🛑 Dayandır / 🔁 retry.
 * @param {string} chatId
 * @param {string} action
 * @param {object} ctx — { send, edit, deleteMsg, messageId }
 */
async function handleAction(chatId, action, ctx) {
  const s = sessionManager.get(chatId);
  if (!s || !action) return false;
  sessionManager.touch(chatId);

  const [cmd, payload] = action.split(':');

  if (cmd === 'send') {
    if (s.state !== STATES.SS_CONFIRM || !s.pendingPayload || s.numbers.length === 0) return true;
    const { built, spec } = s.pendingPayload;
    s.pendingPayload = null;
    s.state = STATES.IDLE;

    // Təsdiq mesajı canlı progress mesajına çevrilir (eyni id — ən aşağıda)
    const progressMsgId = s.ssMsgId || ctx.messageId || null;

    const job = broadcastService.createJob({
      chatId,
      type: built.type,
      payloadSpec: spec,
      targets: s.numbers.map((n) => ({ phone: n.phone, name: n.name })),
      progressMsgId,
      tempFile: built.tempFile || null,
    });
    if (!job) {
      await sendFlowMessage(chatId, ctx, '❌ Job yaradılmadı.', MENU_BUTTON);
      return true;
    }
    s.jobId = job.id;
    // Təsdiq mesajı dərhal canlı progressə çevrilir: 🛑 Dayandır tam genişlikdə
    await editFlow(chatId, ctx, '🚀 Göndəriş başladı…\n\n📨 İş növbəyə alındı və davam edir.', SS_STOP_BUTTONS);
    // Numbers stay for potential retry; session flow is done.
    sessionManager.reset(chatId);
    return true;
  }

  if (cmd === 'back') {
    cleanupPending(s);
    s.state = STATES.SS_CONTENT;
    await sendFlowMessage(chatId, ctx, `✖️ Geri qayıtdınız.\n\n👥 ${s.numbers.length} nömrə\n\n${CONTENT_PROMPT}`);
    return true;
  }

  if (cmd === 'stop') {
    // 🛑 Dayandır — cancel the active broadcast for this chat
    broadcastService.cancelChatJobs(chatId);
    sessionManager.cancel(chatId);
    await cleanup.deleteTracked(chatId);
    return true;
  }

  if (cmd === 'retry') {
    const jobId = payload;
    const old = require('../modules/jobStore').read(jobId);
    if (!old || String(old.chatId) !== String(chatId)) {
      await sendFlowMessage(chatId, ctx, '❌ İş tapılmadı və ya artıq silinib.', MENU_BUTTON);
      return true;
    }
    // Fresh progress message with a live stop button, then enqueue
    await sendFlowMessage(chatId, ctx, '📤 Yenidən göndərilir…', SS_STOP_BUTTONS);
    const progressMsgId = s.ssMsgId || null;
    const newJob = broadcastService.retryFailed(jobId, progressMsgId);
    if (!newJob) {
      await sendFlowMessage(chatId, ctx, '❌ Yenidən cəhd üçün xəta olan nömrə yoxdur.', MENU_BUTTON);
      return true;
    }
    s.jobId = newJob.id;
    sessionManager.reset(chatId);
    return true;
  }

  if (cmd === 'again') {
    const jobId = payload;
    const old = require('../modules/jobStore').read(jobId);
    if (!old || String(old.chatId) !== String(chatId) || old.targets.length === 0) {
      await sendFlowMessage(chatId, ctx, '❌ İş tapılmadı və ya artıq silinib.', MENU_BUTTON);
      return true;
    }
    // Reuse the previous target list for a brand-new message
    sessionManager.cancel(chatId);
    const fresh = sessionManager.get(chatId);
    fresh.state = STATES.SS_CONTENT;
    fresh.numbers = old.targets.map((t) => ({ phone: t.phone, name: t.name }));
    sessionManager.touch(chatId);
    await sendFlowMessage(chatId, ctx, `👥 ${fresh.numbers.length} nömrə

💬 Yeni mesajı yaz (mətn və ya media):`);
    return true;
  }

  return false;
}

module.exports = { start, handle, handleAction };
