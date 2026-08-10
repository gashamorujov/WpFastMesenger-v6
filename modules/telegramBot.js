/**
 * TelegramBot — Telegram module (singleton).
 *
 * The project has exactly FOUR commands: .rr, .ss, .gg, .cc.
 * There are no menus, inline keyboards or other commands. All commands are
 * typed in Telegram and executed on the connected WhatsApp account(s).
 *
 * Pair Code connection: when the bot is idle and the user sends a plain
 * phone number (e.g. 994501234567), the bot starts a WhatsApp pairing.
 * Existing sessions reconnect automatically on boot.
 *
 * Duplicate-message guarantees:
 *  - exactly ONE bot instance and ONE polling loop per process
 *  - polling is restarted on the SAME instance (Telegram offset preserved)
 *  - a global update dedup map drops any message that arrives twice
 *  - webhook is cleared with drop_pending_updates on boot
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { makeLogger } = require('./logger');
const { parseCommand, isSinglePhoneNumber } = require('./commandParser');
const { sessionManager, setTelegramMessenger, getTelegramMessenger } = require('./services');
const { STATES } = require('./sessionManager');
const wa = require('./whatsappManager');
const { sleep } = require('../lib/myfunc');
const rr = require('../commands/rr');
const ss = require('../commands/ss');
const contacts = require('../commands/contacts');
const tgPayload = require('../lib/telegramPayload');
const { MAIN_MENU_BUTTONS, CONNECTION_MENU_BUTTONS, CANCEL_BUTTON } = require('../lib/menu');
const broadcastService = require('./broadcastService');
const cleanup = require('./messageCleanup');

const LOG = makeLogger('BOT');

// ─── /start banner ───
const BANNER_PATH = path.join(__dirname, '..', 'assets', 'banner.png');
const START_CAPTION =
  '🚀 İndi göndərim — WpFastMesenger!\n\n' +
  '📲 Qeydiyyat — WhatsApp-a qoşul\n' +
  '📇 .rr — kontaktları əlavə et\n' +
  '📨 .ss — toplu mesaj göndər\n' +
  '⛔ .cc — hər şeyi ləğv et\n\n' +
  'Sürətli, təhlükəsiz, tam avtomatik!';

const GG_PROMPT =
  '📲 WhatsApp-a bağlanmaq üçün nömrənizi göndərin.\n\n' +
  'Format: 994XXXXXXXXX\n' +
  'Nümunə: 994501234567\n\n' +
  'Qoşulma seçdiyiniz üsulla baş verəcək:\n' +
  '🔐 Pair Code → WhatsApp → Linked Devices → Link with phone number\n' +
  '📷 QR Code → WhatsApp → Linked Devices → Link a Device → Scan';

let bot = null;
let botToken = null;
let botReady = false;
let creating = false;

// ─── Update dedup (global, module-level: survives polling restarts) ───
const seen = new Map(); // "chatId:messageId" -> timestamp
const SEEN_TTL_MS = 2 * 60 * 1000;

function isFresh(chatId, messageId) {
  const key = `${chatId}:${messageId}`;
  const now = Date.now();
  if (seen.has(key)) return false;
  seen.set(key, now);
  if (seen.size > 3000) {
    for (const [k, ts] of seen) {
      if (now - ts > SEEN_TTL_MS) seen.delete(k);
    }
  }
  return true;
}

// ─── Public API ───

async function startBot(token) {
  if (creating) {
    LOG.info('Bot creation in progress — duplicate start ignored');
    return;
  }
  if (bot && botReady && botToken === token) {
    LOG.info('Bot already running — duplicate start ignored');
    return;
  }

  creating = true;
  botToken = token;
  process.env.NTBA_FIX_319 = '1';

  try {
    // Clear any existing webhook first (prevents 409 conflicts / replay)
    await deleteWebhook(token);

    if (bot) {
      LOG.info('Closing previous bot instance...');
      try { await bot.stopPolling(); } catch {}
      try { bot.removeAllListeners(); } catch {}
      bot = null;
      botReady = false;
    }

    await createBot(token);
  } finally {
    creating = false;
  }
}

async function createBot(token) {
  if (bot) return; // guard: never create a second instance
  try {
    const instance = new TelegramBot(token, {
      polling: {
        interval: 2000,
        params: { timeout: 30 },
        autoStart: false, // start after handlers are registered
      },
    });

    bot = instance;
    registerHandlers(instance);
    setTelegramMessenger(buildMessenger(instance));

    await instance.startPolling();
    botReady = true;
    LOG.info('Telegram Bot started!');
  } catch (err) {
    LOG.error('Create bot error:', err.message);
    if (bot) {
      try { bot.removeAllListeners(); } catch {}
      bot = null;
      botReady = false;
    }
    // Retry only when no instance exists (never stack two instances)
    setTimeout(() => { if (!bot) createBot(token); }, 10000);
  }
}

function buildMessenger(instance) {
  return {
    sendText: (chatId, text, opts) => instance.sendMessage(chatId, text, opts || {}),
    sendPhoto: (chatId, buffer, caption, opts) => instance.sendPhoto(chatId, buffer, { caption, ...(opts || {}) }),
    editButtons: (chatId, messageId, buttons) =>
      instance.editMessageReplyMarkup({ inline_keyboard: buttons }, { chat_id: chatId, message_id: messageId }),
    editText: (chatId, messageId, text) =>
      instance.editMessageText(text, { chat_id: chatId, message_id: messageId }),
    editMessage: (chatId, messageId, text, opts) =>
      instance.editMessageText(text, { chat_id: chatId, message_id: messageId, ...(opts || {}) }),
    deleteMessage: (chatId, messageId) => instance.deleteMessage(chatId, messageId),
    downloadFile: async (fileId) => {
      const file = await instance.getFile(fileId);
      if (!file?.file_path) throw new Error('Telegram file path unavailable');
      const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
      const buffer = await new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('File download timeout')));
      });
      return { buffer, filePath: file.file_path };
    },
  };
}

// ─── Handler registration (once per instance) ───

function registerHandlers(instance) {
  // Polling errors — restart on the SAME instance (offset preserved)
  instance.on('polling_error', (err) => {
    const msg = err?.message || '';
    if (msg.includes('timeout') || msg.includes('ETIMEOUT') || err?.code === 'ETIMEDOUT') return;

    if (err?.code === 'EFATAL' || msg.includes('EFATAL')) {
      LOG.warn('Polling EFATAL — restarting polling in 5s (same instance)');
      setTimeout(async () => {
        if (!bot) return;
        try { await bot.stopPolling(); } catch {}
        try { await bot.startPolling(); } catch (e) { LOG.error('Polling restart:', e.message); }
      }, 5000);
      return;
    }

    LOG.warn('Polling error:', err?.code, msg);
  });

  instance.on('webhook_error', () => {});

  instance.on('error', (err) => {
    if (err?.message?.includes('timeout') || err?.code === 'ETIMEDOUT') return;
    LOG.warn('Bot error:', err.message);
  });

  // ─── Inline buttons on the /start banner ───
  instance.on('callback_query', (query) => {
    handleCallback(query).catch((err) => LOG.error('Callback handler error:', err.message));
  });

  // ─── Messages (single entry point for ALL flows) ───
  instance.on('message', (msg) => {
    routeMessage(msg).catch((err) => LOG.error('Message handler error:', err.message));
  });
}

/**
 * A button tap on the /start banner behaves exactly like typing the command.
 * Special registration callbacks (.gg → connection menu: pair / qr / logout /
 * menu / cc) are handled here; everything else is routed as text.
 */
async function handleCallback(query) {
  if (!query?.data || !query?.message?.chat?.id) return;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  try { await bot.answerCallbackQuery(query.id); } catch {}

  const data = query.data;

  // Qeydiyyat → connection menu (Pair Code / QR Code / Log Out)
  if (data === '.gg') {
    await setMenu(chatId, messageId, CONNECTION_MENU_BUTTONS);
    return;
  }
  if (data === 'menu') {
    await setMenu(chatId, messageId, MAIN_MENU_BUTTONS);
    return;
  }
  if (data === 'pair' || data === 'qr') {
    sessionManager.cancel(chatId);
    const s = sessionManager.get(chatId);
    s.flow = data;
    sessionManager.touch(chatId);
    await sendText(chatId, GG_PROMPT, { reply_markup: { inline_keyboard: CANCEL_BUTTON } });
    return;
  }
  if (data === 'cc') {
    // ⛔ Prosesi ləğv et — .cc ilə eyni funksiya
    // Düymənin olduğu sorğu mesajı silinir, sonra ləğv təsdiqi göndərilir
    try { await bot.deleteMessage(chatId, messageId); } catch {}
    sessionManager.cancel(chatId);
    await cleanup.deleteTracked(chatId);
    broadcastService.cancelChatJobs(chatId);
    await sendText(chatId, '✅ Əməliyyat uğurla ləğv edildi.', { reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS } });
    return;
  }
  if (data === 'logout') {
    await handleLogout(chatId);
    return;
  }

  const ctx = callbackCtx(chatId, messageId);

  // Bulk-message job callbacks (namespace `sp:`: send / back / stop / retry)
  if (data.startsWith('sp:')) {
    const action = data.slice(3);
    try {
      await ss.handleAction(chatId, action, ctx);
    } catch (e) {
      LOG.error('SS callback error:', e.message);
    }
    return;
  }

  // Contact browser callbacks (namespace `ct:`: view / rename / num / del / page / back)
  if (data.startsWith('ct:')) {
    const action = data.slice(3);
    try {
      await contacts.handleAction(chatId, action, ctx);
    } catch (e) {
      LOG.error('Contacts callback error:', e.message);
    }
    return;
  }

  await routeMessage({
    chat: { id: chatId },
    message_id: `cb:${query.id}`,
    text: data,
    from: query.from,
  });
}

/**
 * Transport ctx for callback queries: send / edit the tapped message /
 * deleteMsg, with the tapped message's id.
 */
function callbackCtx(chatId, messageId) {
  const messenger = getTelegramMessenger();
  return {
    messageId,
    send: (text, opts) => sendText(chatId, text, opts),
    edit: (text, opts) => messenger.editMessage(chatId, messageId, text, opts || {}),
    deleteMsg: (cid, mid) => messenger.deleteMessage(cid, mid),
  };
}

/** Show a button layout on the given message; fall back to a new message. */
async function setMenu(chatId, messageId, buttons) {
  const m = getTelegramMessenger();
  if (!m) return;
  if (messageId) {
    try {
      await m.editButtons(chatId, messageId, buttons);
      return;
    } catch (e) {
      LOG.warn('editMenu failed, resending:', e.message);
    }
  }
  try {
    await m.sendText(chatId, '🎛 Menyu:', { reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    LOG.error('setMenu failed:', e.message);
  }
}

/** Log out all WhatsApp sessions, then automatically show the main menu. */
async function handleLogout(chatId) {
  const entries = Object.entries(wa.sessionsData || {});
  if (entries.length === 0) {
    await sendText(chatId, '❌ Silinəcək sessiya yoxdur.');
    return;
  }
  for (const [phone] of entries) {
    try {
      await wa.disconnectSession(phone);
      LOG.info('Logged out +' + phone);
    } catch (err) {
      LOG.error('Logout error +' + phone, err.message);
    }
  }
  await sendText(chatId, '✅ Bütün WhatsApp sessiyaları təmizləndi.');
  await sendBanner(chatId); // main menu reappears automatically
}

// ─── Routing ───

async function routeMessage(msg) {
  if (!msg?.chat?.id) return;
  const chatId = msg.chat.id;

  // Global dedup: the same update must never be processed twice
  if (!isFresh(chatId, msg.message_id)) {
    LOG.warn(`Dropped duplicate update (chat ${chatId}, msg ${msg.message_id})`);
    return;
  }

  const text = msg.text || '';
  if (text.trim()) LOG.info(`Message from ${chatId}: "${text.trim().slice(0, 60)}"`);

  const s = sessionManager.get(chatId);
  sessionManager.touch(chatId);

  const cmd = parseCommand(normalizeCommandText(text));

  // /start — banner + welcome message
  if (text.trim().toLowerCase() === '/start') {
    await sendBanner(chatId);
    return;
  }

  // Transport-bound helpers for this chat
  const send = (replyText, opts) => sendText(chatId, replyText, opts);
  const messenger = getTelegramMessenger();
  const buildPayload = (m) => tgPayload.buildPayload(m, messenger?.downloadFile);
  const isCb = String(msg.message_id || '').startsWith('cb:');
  const realMessageId = isCb ? null : msg.message_id || null;
  const edit = messenger
    ? (text, opts) => {
        const flowMsgId = s.ctMsgId || s.ssMsgId || null;
        const target = flowMsgId || realMessageId;
        if (!target) return Promise.reject(new Error('no message to edit'));
        return messenger.editMessage(chatId, target, text, opts || {});
      }
    : null;
  const deleteMsg = messenger ? (cid, mid) => messenger.deleteMessage(cid, mid) : null;
  const ctx = { send, edit, deleteMsg, messageId: realMessageId };

  // .cc — cancel the active process at ANY stage, anywhere (highest priority)
  if (cmd?.type === 'cc') {
    sessionManager.cancel(chatId);
    await cleanup.deleteTracked(chatId);
    broadcastService.cancelChatJobs(chatId);
    await send('✅ Əməliyyat uğurla ləğv edildi.', { reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS } });
    return;
  }

  if (cmd?.type === 'gg') {
    const phone = (cmd.arg || '').replace(/[^0-9]/g, '');
    if (phone && phone.length >= 7 && phone.length <= 15) {
      // .gg 994501234567 → pair immediately
      sessionManager.cancel(chatId);
      await handlePairInput(chatId, { text: phone });
      return;
    }
    // .gg → ask for the number first (default Pair Code)
    sessionManager.cancel(chatId);
    const s = sessionManager.get(chatId);
    s.flow = 'pair';
    sessionManager.touch(chatId);
    await send(GG_PROMPT, { reply_markup: { inline_keyboard: CANCEL_BUTTON } });
    return;
  }

  if (cmd?.type === 'rr') {
    await rr.start(chatId, send);
    return;
  }

  if (cmd?.type === 'ss') {
    await ss.start(chatId, ctx, cmd.arg);
    return;
  }

  // Pair Code / QR Code flow — waiting for a phone number
  if (s.flow === 'pair' || s.flow === 'qr') {
    await handlePairInput(chatId, msg);
    return;
  }

  // Active .rr / .ss flows
  if (s.state === STATES.RR) {
    await rr.handle(chatId, text, send);
    return;
  }
  if (s.state === STATES.SS_NUMBERS || s.state === STATES.SS_CONTENT) {
    await ss.handle(chatId, msg, text, ctx, buildPayload);
    return;
  }
  if (s.state === STATES.CT_RENAME || s.state === STATES.CT_NUMBER || s.state === STATES.CT_SEARCH) {
    await contacts.handleText(chatId, text, ctx);
    return;
  }

  // Idle + a single phone number → start WhatsApp pairing
  if (isSinglePhoneNumber(text)) {
    await handlePairInput(chatId, msg);
    return;
  }

  // Unknown input while idle: commands are .rr / .ss / .gg / .cc — no reply needed.
}

/**
 * Map friendly aliases to the real commands:
 *   /qeydiyyat and /gg behave exactly like .gg (WhatsApp registration).
 */
function normalizeCommandText(text) {
  if (!text || typeof text !== 'string') return text;
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower === '/qeydiyyat' || lower === '/gg') return '.gg';
  if (lower.startsWith('/qeydiyyat ')) return '.gg' + t.slice('/qeydiyyat'.length);
  if (lower.startsWith('/gg ')) return '.gg' + t.slice(3);
  return text;
}

// ─── Pair Code flow ───

async function handlePairInput(chatId, msg) {
  const s = sessionManager.get(chatId);
  const text = msg.text || '';
  const method = s.flow === 'qr' ? 'qr' : 'pair';

  const phone = text.replace(/[^0-9]/g, '');
  if (!phone || phone.length < 7 || phone.length > 15) {
    await sendText(
      chatId,
      '❌ Yanlış nömrə formatı.\n\nDüzgün format: 994XXXXXXXXX\nNümunə: 994501234567',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  sessionManager.reset(chatId); // clear any stale state

  try {
    await wa.connectWithPhone(phone, method, bot, chatId);
  } catch (err) {
    LOG.error('Pair error:', err.message);
  }
}

// ─── Helpers ───

async function sendText(chatId, text, opts) {
  const m = getTelegramMessenger();
  if (!m) return null;
  try {
    return await m.sendText(chatId, text, opts || {});
  } catch (e) {
    LOG.error('sendMessage failed:', e.message);
    return null;
  }
}

async function sendBanner(chatId) {
  const m = getTelegramMessenger();
  if (!m) return null;
  try {
    if (fs.existsSync(BANNER_PATH)) {
      const buffer = fs.readFileSync(BANNER_PATH);
      return await m.sendPhoto(chatId, buffer, START_CAPTION, {
        reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS },
      });
    }
  } catch (e) {
    LOG.error('sendBanner failed:', e.message);
  }
  try {
    return await m.sendText(chatId, START_CAPTION);
  } catch (e) {
    LOG.error('sendBanner fallback failed:', e.message);
    return null;
  }
}

function deleteWebhook(token) {
  return new Promise((resolve) => {
    try {
      const req = https.get(
        `https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`,
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const r = JSON.parse(data);
              if (r.ok) LOG.info('Webhook cleared (pending updates dropped)');
              else LOG.warn('deleteWebhook:', r.description || 'failed');
            } catch {}
            resolve();
          });
        }
      );
      req.on('error', () => resolve());
      req.setTimeout(5000, () => { req.destroy(); resolve(); });
    } catch {
      resolve();
    }
  });
}

module.exports = { startBot, getBot: () => bot, isFresh, routeMessage, handleCallback };
