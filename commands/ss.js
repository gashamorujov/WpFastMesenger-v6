/**
 * .ss — toplu mesaj: nömrələr → mesaj → təsdiq → 🚀 Göndər.
 *
 * Flow (single evolving bot message — köhnə mesajlar yığılmır):
 *   1. `.ss` → "📱 Nömrələri göndər:"
 *   2. istənilən sayda nömrə (sətir/vergül/boşluq və s. ayırıcılarla) →
 *      normalizə + duplicate sil + yanlışları göstər → "💬 Mesajı yaz:"
 *   3. mesaj/media → təsdiq ekranı: 📨 Hazırdır + [🚀 Göndər][✖️ Geri]
 *   4. 🚀 Göndər → persistent job başlayır; eyni mesaj canlı progress
 *      olur: 📤 37/100 + [🛑 Dayandır]
 *   5. Tamamlanma/ləğv → eyni mesaj yekun nəticəyə çevrilir
 *      ([🛑 Dayandır] avtomatik silinir)
 *
 * Real göndərmə: hər nömrə üçün Baileys sendMessage çağırılır; uğur
 * yalnız server qəbul etdikdə (və istəyə görə server ACK gözlənilir)
 * ✅ hesab olunur. Xəta → ❌, heç vaxt saxta "sent" göstərilmir.
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

const NUMBERS_PROMPT = '📱 Nömrələri göndər:\n\nİstənilən sayda (1, 10, 100+).\nSətir, vergül və ya boşluqla ayırın:\n0501234567, 0551234567, 0771234567…';
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

/** Edit the single evolving flow message; fall back to a new message. */
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
  if (sent?.message_id) s.ssMsgId = sent.message_id;
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
  await editFlow(chatId, ctx, NUMBERS_PROMPT);
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
  await editFlow(chatId, ctx, text, SS_CONFIRM_BUTTONS);
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

  // ── Numbers phase ──
  if (s.state === STATES.SS_NUMBERS) {
    const { numbers, duplicates, invalid } = extractNumbers(text);
    if (numbers.length === 0) {
      await editFlow(chatId, ctx, `❌ Nömrə tapılmadı.\n\n${NUMBERS_PROMPT}`);
      return true;
    }

    const existing = new Set(s.numbers.map((n) => n.phone));
    const fresh = numbers.filter((n) => !existing.has(n));
    for (const n of fresh) s.numbers.push({ phone: n, name: null });

    const recent = fresh.filter((n) => recentSends.isRecent(n));
    s.state = STATES.SS_CONTENT;
    await editFlow(chatId, ctx, numbersReport(s.numbers.map((n) => n.phone), duplicates, invalid, recent));
    return true;
  }

  // ── Content phase: more numbers can still be appended ──
  if (text && isNumbersOnly(text)) {
    const { numbers, duplicates, invalid } = extractNumbers(text);
    const existing = new Set(s.numbers.map((n) => n.phone));
    const fresh = numbers.filter((n) => !existing.has(n));
    for (const n of fresh) s.numbers.push({ phone: n, name: null });
    const recent = fresh.filter((n) => recentSends.isRecent(n));
    if (fresh.length === 0) {
      await editFlow(chatId, ctx, `🔁 Yeni nömrə əlavə olunmadı (hamısı mövcuddur).\n\n👥 ${s.numbers.length} nömrə:\n\n${numberLines(s.numbers.map((n) => n.phone)).join('\n')}\n\n${CONTENT_PROMPT}`);
    } else {
      await editFlow(chatId, ctx, numbersReport(s.numbers.map((n) => n.phone), duplicates, invalid, recent));
    }
    return true;
  }

  if (s.numbers.length === 0) {
    await editFlow(chatId, ctx, `❌ Nömrə yoxdur. Yenidən .ss yazın.`, MENU_BUTTON);
    sessionManager.reset(chatId);
    return true;
  }

  // Build payload from the received message (format preserved)
  const built = await buildPayload(msg);
  if (!built.payload) {
    await editFlow(chatId, ctx, `❌ ${built.reason || 'Bu mesaj növü dəstəklənmir.'}`, MENU_BUTTON);
    return true;
  }

  const sender = wa.getSenderSocket();
  if (!sender || !sender.sock) {
    await editFlow(chatId, ctx, '❌ Aktiv WhatsApp bağlantısı yoxdur. Əvvəlcə 📲 Qoşul ilə qoşulun.', MENU_BUTTON);
    if (built.tempFile) {
      try { fs.removeSync(built.tempFile); } catch {}
    }
    return true;
  }

  // Hold the payload until the user confirms (🚀 Göndər / ✖️ Geri)
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

    // The confirm message becomes the live progress message (same id)
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
      await editFlow(chatId, ctx, '❌ Job yaradılmadı.', MENU_BUTTON);
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
    await editFlow(chatId, ctx, `✖️ Geri qayıtdınız.\n\n👥 ${s.numbers.length} nömrə\n\n${CONTENT_PROMPT}`);
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
      await editFlow(chatId, ctx, '❌ İş tapılmadı və ya artıq silinib.', MENU_BUTTON);
      return true;
    }
    // Send a fresh progress message with a live stop button, then enqueue
    const sent = await ctx.send('📤 Yenidən göndərilir…', { reply_markup: { inline_keyboard: SS_STOP_BUTTONS } });
    const progressMsgId = sent?.message_id || null;
    const newJob = broadcastService.retryFailed(jobId, progressMsgId);
    if (!newJob) {
      await editFlow(chatId, ctx, '❌ Yenidən cəhd üçün xəta olan nömrə yoxdur.', MENU_BUTTON);
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
      await editFlow(chatId, ctx, '❌ İş tapılmadı və ya artıq silinib.', MENU_BUTTON);
      return true;
    }
    // Reuse the previous target list for a brand-new message
    sessionManager.cancel(chatId);
    const fresh = sessionManager.get(chatId);
    fresh.state = STATES.SS_CONTENT;
    fresh.numbers = old.targets.map((t) => ({ phone: t.phone, name: t.name }));
    sessionManager.touch(chatId);
    await editFlow(chatId, ctx, `👥 ${fresh.numbers.length} nömrə

💬 Yeni mesajı yaz (mətn və ya media):`);
    return true;
  }

  return false;
}

module.exports = { start, handle, handleAction };
