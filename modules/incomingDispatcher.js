/**
 * incomingDispatcher — gələn WhatsApp mesajlarının Telegram-a ötürülməsi.
 *
 * Qoşulmuş WhatsApp hesabına gələn sorğular (toplu göndərişdəki
 * recipientlərin cavabları və s.) hesabın sahib Telegram çatına əks olunur.
 * Toplu göndəriş (broadcast) aktiv olduğu müddətdə gələn mesajlar yaddaşda
 * saxlanılır və göndəriş TAMAMLANANDAN SONRA ardıcıl olaraq ötürülür —
 * beləliklə gələn sorğular həmişə bizim göndərdiyimiz mesajın (yekun
 * hesabatın) aşağısında, ən aşağıda görünür.
 *
 * Nəzarət: WA_FORWARD_INCOMING (default "true"; "false"/"0" = söndür).
 */
const { makeLogger } = require('./logger');
const { getTelegramMessenger } = require('./services');
const { formatPhone } = require('../lib/azPhone');

const LOG = makeLogger('WA-INCOMING');

const WA_FORWARD_INCOMING =
  process.env.WA_FORWARD_INCOMING !== 'false' && process.env.WA_FORWARD_INCOMING !== '0';

// phone -> telegram chatId (hesabın sahibinin çatı)
const chatIds = new Map();

// chatId -> aktiv broadcast sayı (0 = ötürmə dərhal)
const active = new Map();

// chatId -> göndəriş bitdikdən sonra ötürüləcək sətirlər
const buffers = new Map();

// `phone:key:remote` -> timestamp (dublikat mühafizəsi)
const seen = new Map();
const SEEN_TTL_MS = 5 * 60 * 1000;

const MAX_BUFFER = 500;

function isFresh(key) {
  const now = Date.now();
  if (seen.has(key)) return false;
  seen.set(key, now);
  if (seen.size > 5000) {
    for (const [k, ts] of seen) {
      if (now - ts > SEEN_TTL_MS) seen.delete(k);
    }
  }
  return true;
}

/** Gələn mesajın mətnini/mövzusunu çıxarır (media daxil). */
function describe(msg) {
  const m = msg.message;
  if (!m) return null;

  // Dərinliyi məhdudlaşdıraraq zərfləri aç
  let depth = 0;
  let cur = m;
  while (depth < 5) {
    if (cur.ephemeralMessage?.message) cur = cur.ephemeralMessage.message;
    else if (cur.viewOnceMessage?.message) cur = cur.viewOnceMessage.message;
    else if (cur.documentWithCaptionMessage?.message) cur = cur.documentWithCaptionMessage.message;
    else break;
    depth++;
  }

  if (typeof cur.conversation === 'string' && cur.conversation) return cur.conversation;
  if (cur.extendedTextMessage?.text) return cur.extendedTextMessage.text;
  if (cur.imageMessage) {
    const cap = cur.imageMessage.caption;
    return `🖼 Şəkil${cap ? ` — ${cap}` : ''}`;
  }
  if (cur.videoMessage) {
    const cap = cur.videoMessage.caption;
    return `🎬 Video${cap ? ` — ${cap}` : ''}`;
  }
  if (cur.audioMessage) return cur.audioMessage.ptt ? '🎙 Səs mesajı' : '🎵 Audio';
  if (cur.documentMessage) return `📄 ${cur.documentMessage.fileName || 'Fayl'}`;
  if (cur.stickerMessage) return '😀 Stiker';
  if (cur.contactMessage) return '📇 Kontakt kartı';
  if (cur.locationMessage) return '📍 Məkan';
  if (cur.buttonsResponseMessage?.selectedButtonText) return `🔘 ${cur.buttonsResponseMessage.selectedButtonText}`;
  if (cur.listResponseMessage?.singleSelectReply?.selectedRowId) return `📋 ${cur.listResponseMessage.singleSelectReply.selectedRowId}`;
  return null;
}

/** Göndərəni göstərilə bilən etiketə çevirir. */
function senderLabel(remote, pushName) {
  const number = String(remote || '').split('@')[0];
  const pretty = /^\d{7,15}$/.test(number) ? formatPhone(number) : number;
  const name = pushName || pretty;
  if (String(remote).endsWith('@g.us')) return `${name} (qrup: ${pretty})`;
  return name === pretty ? pretty : `${name} — ${pretty}`;
}

async function sendNow(chatId, line) {
  const m = getTelegramMessenger();
  if (!m || typeof m.sendText !== 'function') return;
  try {
    await m.sendText(chatId, line);
  } catch (e) {
    LOG.warn('Incoming forward failed:', e.message);
  }
}

async function handleMessage(phone, msg, type) {
  if (!msg?.message || !msg.key) return;
  if (msg.key.fromMe === true) return; // öz göndərdiyimiz mesaj
  const remote = String(msg.key.remoteJid || '');
  if (!remote) return;
  if (remote.endsWith('@broadcast') || remote === 'status@broadcast') return; // status yeniləmələri
  if (remote.endsWith('@newsletter')) return;

  // Protocol / reaksiya / təsdiq kimi qeyri-məzmun mesajları ötürülmür
  if (msg.message.protocolMessage || msg.message.reactionMessage || msg.message.senderKeyDistributionMessage) return;

  const content = describe(msg);
  if (!content) return;

  const key = `${phone}:${msg.key.id || ''}:${remote}`;
  if (!isFresh(key)) return;

  const chatId = chatIds.get(phone);
  if (!chatId) return;

  const line =
    `📥 Gələn sorğu (WhatsApp)\n` +
    `👤 ${senderLabel(remote, msg.pushName)}\n` +
    `💬 ${content}`;

  if ((active.get(chatId) || 0) > 0) {
    // Toplu göndəriş aktivdir → bitəndən sonra ən aşağıda görünsün
    const list = buffers.get(chatId) || [];
    if (list.length < MAX_BUFFER) list.push(line);
    buffers.set(chatId, list);
  } else {
    await sendNow(chatId, line);
  }
}

/**
 * Baileys soketinin gələn mesaj dinləyicisini qeydiyyatdan keçirir.
 * Hər soket üçün bir dəfə çağırılır.
 */
function attach(sock, phone) {
  if (!sock || typeof sock?.ev?.on !== 'function') return;
  if (sock.__incomingAttached) return;
  sock.__incomingAttached = true;
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (!WA_FORWARD_INCOMING) return;
    if (type !== 'notify') return; // tarix sinxronizasiyası (append/replace) atlanır
    for (const msg of messages || []) {
      handleMessage(phone, msg, type).catch((e) => LOG.warn('Incoming handler error:', e.message));
    }
  });
}

/** Hesabın sahib Telegram çatını qeyd edir. */
function setChat(phone, chatId) {
  if (!phone) return;
  if (chatId) chatIds.set(phone, String(chatId));
  else if (chatIds.has(phone)) chatIds.delete(phone);
}

/** Hesab silinəndə qeydləri təmizləyir. */
function removePhone(phone) {
  chatIds.delete(phone);
}

/**
 * Broadcast başlayanda çağırılır — gələn sorğular buraxılış bitənə qədər
 * yaddaşda saxlanılır.
 */
function pause(chatId) {
  if (!chatId) return;
  active.set(chatId, (active.get(chatId) || 0) + 1);
}

/**
 * Broadcast bitəndə çağırılır. Aktiv iş sayı 0 olan kimi yığılmış sorğular
 * ardıcıl ötürülür (ən aşağıda görünür).
 */
function resume(chatId) {
  if (!chatId) return;
  const n = (active.get(chatId) || 0) - 1;
  if (n <= 0) {
    active.delete(chatId);
    flush(chatId);
  } else {
    active.set(chatId, n);
  }
}

/** Saxlanmış sorğuları ardıcıllıqla ötürür. */
async function flush(chatId) {
  const list = buffers.get(chatId) || [];
  buffers.delete(chatId);
  for (const line of list) {
    await sendNow(chatId, line);
  }
}

/** Testlər üçün daxili vəziyyəti sıfırlayır. */
function _reset() {
  chatIds.clear();
  active.clear();
  buffers.clear();
  seen.clear();
}

module.exports = { attach, setChat, removePhone, pause, resume, flush, describe, senderLabel, WA_FORWARD_INCOMING, _reset };
