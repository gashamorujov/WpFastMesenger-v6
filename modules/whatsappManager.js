/**
 * WhatsAppManager — Baileys socket lifecycle.
 *
 * Responsibilities:
 *  - connect via Pair Code or QR
 *  - persist sessions (sessions/sessions.json + auth state)
 *  - auto-reconnect with exponential backoff
 *  - watchdog for dead connections
 *  - deliver incoming messages to the WhatsApp dispatcher exactly once
 *
 * The Telegram bot is passed in as a plain messenger (optional): when the
 * watchdog reconnects there is no active chat to report to.
 */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const { sleep } = require('../lib/myfunc');
const { makeLogger } = require('./logger');
const incoming = require('./incomingDispatcher');

const LOG = makeLogger('WA');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
const SESSION_DATA_FILE = path.join(SESSIONS_DIR, 'sessions.json');

fs.ensureDirSync(SESSIONS_DIR);

let sessionsData = {};
try {
  if (fs.existsSync(SESSION_DATA_FILE)) {
    sessionsData = JSON.parse(fs.readFileSync(SESSION_DATA_FILE, 'utf-8'));
  }
} catch {
  sessionsData = {};
}

function saveSessionsData() {
  try {
    fs.writeFileSync(SESSION_DATA_FILE, JSON.stringify(sessionsData, null, 2));
  } catch (e) {
    LOG.error('saveSessionsData:', e.message);
  }
}

const activeConnections = {};

const connectedHooks = [];

/** Register a callback fired whenever any WhatsApp socket connects. */
function onConnected(cb) {
  if (typeof cb === 'function') connectedHooks.push(cb);
}

function fireConnectedHooks(phone, sock) {
  for (const cb of connectedHooks) {
    try {
      Promise.resolve(cb(phone, sock)).catch((e) => LOG.error('Connected hook error:', e.message));
    } catch (e) {
      LOG.error('Connected hook error:', e.message);
    }
  }
}

const fmtPhone = (n) => String(n || '').replace(/[^0-9]/g, '');
const sessDir = (p) => path.join(SESSIONS_DIR, p);

/** Send text through the Telegram bot if one is available. */
async function say(bot, chatId, text, opts) {
  if (!bot || !chatId) return null;
  try {
    return await bot.sendMessage(chatId, text, opts || {});
  } catch (e) {
    LOG.error('say failed:', e.message);
    return null;
  }
}

async function sayPhoto(bot, chatId, buffer, caption) {
  if (!bot || !chatId) return null;
  try {
    return await bot.sendPhoto(chatId, buffer, { caption });
  } catch (e) {
    LOG.error('sayPhoto failed:', e.message);
    return null;
  }
}

// ─── Qoşulma mesajlarının izlənməsi/təmizlənməsi ───
// QR kodu, Pair Code və "qoşulur..." kimi MÜVƏQQƏTİ mesajlar uğurlu
// qoşulmadan sonra avtomatik silinir; yalnız "✅ Uğurla qoşuldu" qalır.
const connTrack = new Map(); // phone -> [{ chatId, messageId }]

function trackConnMsg(phone, msg) {
  if (!phone || !msg?.message_id) return;
  if (!connTrack.has(phone)) connTrack.set(phone, []);
  connTrack.get(phone).push({ chatId: msg.chat?.id, messageId: msg.message_id });
}

async function sayConn(bot, chatId, phone, text, opts) {
  const m = await say(bot, chatId, text, opts);
  trackConnMsg(phone, m);
  return m;
}

async function sayPhotoConn(bot, chatId, phone, buffer, caption) {
  const m = await sayPhoto(bot, chatId, buffer, caption);
  trackConnMsg(phone, m);
  return m;
}

async function clearConnMsgs(phone, bot) {
  const list = connTrack.get(phone) || [];
  connTrack.delete(phone);
  for (const item of list) {
    try {
      if (bot && item.chatId && item.messageId) await bot.deleteMessage(item.chatId, item.messageId);
    } catch {}
  }
}

// All commands are controlled from Telegram; WhatsApp messages are not
// processed by the bot itself (no handlers are registered).

/**
 * Connect (or pair) a phone number.
 * @param {string} phone
 * @param {'pair'|'qr'} method
 * @param {object|null} bot — Telegram bot messenger (optional)
 * @param {string|null} chatId — Telegram chat to report to (optional)
 */
async function connectWithPhone(phone, method = 'pair', bot = null, chatId = null) {
  phone = fmtPhone(phone);
  if (!phone || phone.length < 7 || phone.length > 15) {
    return say(bot, chatId, 'Yanlış nömrə formatı. Düzgün format: 994501234567', { parse_mode: 'Markdown' });
  }

  if (sessionsData[phone]?.status === 'connected' && activeConnections[phone]) {
    return say(bot, chatId, `+${phone} artıq bağlıdır.`);
  }

  const methodName = method === 'qr' ? 'QR Code' : 'Pair Code';
  await sayConn(bot, chatId, phone, `+${phone} ${methodName} ilə qoşulur...`, { parse_mode: 'Markdown' });

  try {
    const dir = sessDir(phone);
    fs.ensureDirSync(dir);
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();
    const msgCache = new NodeCache();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Android', 'Chrome', '20.0.04'],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
      },
      markOnlineOnConnect: true,
      msgRetryCounterCache: msgCache,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      syncFullHistory: true,
    });

    // Gələn WhatsApp mesajları → sahib Telegram çatına (incomingDispatcher)
    incoming.attach(sock, phone);

    let qrSent = false;
    let pairCodeSent = false;
    let connOpen = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECT = 10;
    const reconnectTimers = {};

    sock.ev.on('connection.update', async (s) => {
      const { connection, lastDisconnect, qr } = s;

      if (qr && !qrSent) {
        qrSent = true;
        if (method === 'qr') {
          try {
            const buf = await QRCode.toBuffer(qr, { type: 'png', margin: 2, scale: 8 });
            await sayPhotoConn(bot, chatId, phone, buf, `📷 *QR Code* for +${phone}\n\n1. WhatsApp → Linked Devices\n2. *Link a Device*\n3. *Scan* the QR`);
          } catch (err) {
            LOG.error('QR gen error:', err.message);
            await say(bot, chatId, 'QR xətası: ' + err.message);
            qrSent = false;
          }
        } else if (method === 'pair' && !pairCodeSent) {
          pairCodeSent = true;
          LOG.info(`Socket ready, requesting pairing code for ${phone}`);
          requestPairingCodeWithRetry(sock, phone, bot, chatId).catch((e) => {
            LOG.error(`Pair request failed for ${phone}:`, e.message);
          });
        }
      }

      if (connection === 'open') {
        connOpen = true;
        reconnectAttempts = 0;
        LOG.info('Connected +' + phone);
        sessionsData[phone] = {
          phone,
          status: 'connected',
          connectedAt: new Date().toISOString(),
          name: sock.user?.name || phone,
          jid: sock.user?.id || '',
          method,
          chatId: chatId || sessionsData[phone]?.chatId || null,
        };
        saveSessionsData();
        incoming.setChat(phone, sessionsData[phone].chatId);
        activeConnections[phone] = sock;
        // Müvəqqəti qoşulma mesajları (QR / Pair Code / "qoşulur...") silinir
        await clearConnMsgs(phone, bot);
        await say(bot, chatId, `✅ Uğurla qoşuldu!\n+${phone}\n${sock.user?.name || ''}`, { parse_mode: 'Markdown' });
        fireConnectedHooks(phone, sock);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || '';
        LOG.info('Connection closed for +' + phone, 'code:', code, 'msg:', errMsg);
        delete activeConnections[phone];

        if (code === DisconnectReason.loggedOut || code === 401) {
          clearConnMsgs(phone, bot);
          delete sessionsData[phone];
          saveSessionsData();
          incoming.removePhone(phone);
          try { fs.removeSync(dir); } catch {}
          await say(bot, chatId, `+${phone}: Logged out.`);
          return;
        }

        if (sessionsData[phone]) sessionsData[phone].status = 'reconnecting';
        else sessionsData[phone] = { phone, status: 'reconnecting', method };
        saveSessionsData();

        if (reconnectAttempts < MAX_RECONNECT) {
          const delay = Math.min(3000 * Math.pow(2, reconnectAttempts), 60000);
          reconnectAttempts++;
          LOG.info(`[AutoReconnect] +${phone} attempt ${reconnectAttempts}/${MAX_RECONNECT} in ${delay / 1000}s`);
          reconnectTimers[phone] = setTimeout(async () => {
            if (!activeConnections[phone]) {
              try {
                await connectWithPhone(phone, method, null, null);
              } catch (e) {
                LOG.error(`[AutoReconnect] +${phone} failed:`, e.message);
              }
            }
          }, delay);
        } else {
          LOG.info(`[AutoReconnect] +${phone} max attempts reached, waiting for watchdog`);
          if (sessionsData[phone]) sessionsData[phone].status = 'disconnected';
          saveSessionsData();
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    activeConnections[phone] = sock;

    if (method === 'qr') {
      setTimeout(() => {
        if (!connOpen && !qrSent) {
          say(bot, chatId, `+${phone}: QR yaradılmadı (timeout).`);
          if (activeConnections[phone]) { activeConnections[phone].end(new Error('qr timeout')); delete activeConnections[phone]; }
          if (sessionsData[phone]) sessionsData[phone].status = 'disconnected';
          saveSessionsData();
        }
      }, 30000);
      setTimeout(() => {
        if (!connOpen) {
          say(bot, chatId, `+${phone}: QR scan timeout.`);
          if (activeConnections[phone]) { activeConnections[phone].end(new Error('qr scan timeout')); delete activeConnections[phone]; }
          if (sessionsData[phone]?.status !== 'logged_out') {
            sessionsData[phone].status = 'disconnected';
            saveSessionsData();
          }
        }
      }, 120000);
    }
  } catch (err) {
    LOG.error('Connection error +' + phone, err);
    await say(bot, chatId, 'Xəta: ' + err.message);
  }
}

async function requestPairingCodeWithRetry(sock, phone, bot, chatId, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    if (sessionsData[phone]?.status === 'connected') return;
    if (!activeConnections[phone]) return;
    try {
      LOG.info(`Requesting pairing code for ${phone} (attempt ${i + 1}/${maxRetries})`);
      let code = await sock.requestPairingCode(phone);
      code = code?.match(/.{1,4}/g)?.join('-') || code;
      LOG.info(`Pairing code for ${phone}: ${code}`);

      await sayConn(
        bot,
        chatId,
        phone,
        `🔐 *Pairing Code ready!*\n\n` +
          `Code:\n\`${code}\`\n\n` +
          `📲 WhatsApp → Linked Devices → Link with phone number → enter code\n\n` +
          `⏱ Expires in 5 minutes`,
        { parse_mode: 'Markdown' }
      );
      return;
    } catch (err) {
      const msg = err.message || '';
      LOG.info(`Pairing attempt ${i + 1} failed:`, msg.slice(0, 80));

      if (msg.includes('not authorized') || msg.includes('401') || msg.includes('conflict')) {
        await say(bot, chatId, `Pairing failed.\nReason: ${msg}\n\nTry QR Code method.`, { parse_mode: 'Markdown' });
        if (activeConnections[phone]) { activeConnections[phone].end(new Error('Pair failed')); delete activeConnections[phone]; }
        if (sessionsData[phone]) sessionsData[phone].status = 'disconnected';
        saveSessionsData();
        return;
      }

      if (msg.includes('Connection Closed') || msg.includes('not open') || msg.includes('timedOut')) {
        await sleep(2000);
        continue;
      }

      await sleep(1500);
    }
  }
}

async function disconnectSession(phone) {
  phone = fmtPhone(phone);
  if (activeConnections[phone]) {
    try { activeConnections[phone].end(new Error('User logout')); } catch {}
    delete activeConnections[phone];
  }
  try { fs.removeSync(sessDir(phone)); } catch {}
  delete sessionsData[phone];
  saveSessionsData();
  incoming.removePhone(phone);
  return true;
}

let watchdogStarted = false;
function startConnectionWatchdog() {
  if (watchdogStarted) return;
  watchdogStarted = true;
  LOG.info('Connection watchdog started (every 2 minutes)');
  setInterval(() => {
    for (const [phone, session] of Object.entries(sessionsData)) {
      if ((session.status === 'disconnected' || session.status === 'reconnecting') && !activeConnections[phone]) {
        LOG.info(`[Watchdog] +${phone} is ${session.status}, attempting reconnect...`);
        connectWithPhone(phone, session.method || 'pair', null, null).catch((e) => {
          LOG.error(`[Watchdog] +${phone} reconnect failed:`, e.message);
        });
      }
      if (session.status === 'connected' && !activeConnections[phone]) {
        LOG.info(`[Watchdog] +${phone} marked connected but no active connection. Reconnecting...`);
        sessionsData[phone].status = 'reconnecting';
        saveSessionsData();
        connectWithPhone(phone, session.method || 'pair', null, null).catch((e) => {
          LOG.error(`[Watchdog] +${phone} reconnect failed:`, e.message);
        });
      }
    }
  }, 120000);
}

/** Return the first connected socket (used by .ss broadcasts). */
function getSenderSocket() {
  for (const [phone, session] of Object.entries(sessionsData)) {
    if (session.status === 'connected' && activeConnections[phone]) {
      return { sock: activeConnections[phone], phone };
    }
  }
  return null;
}

module.exports = {
  connectWithPhone,
  disconnectSession,
  startConnectionWatchdog,
  getSenderSocket,
  onConnected,
  activeConnections,
  sessionsData,
  saveSessionsData,
};
