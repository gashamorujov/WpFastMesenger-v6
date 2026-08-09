const path = require('path');
const express = require('express');
const fs = require('fs-extra');
const { makeLogger } = require('./modules/logger');

const LOG = makeLogger('INFO');

// ─── Temp dirs ───
const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP_DIR);
process.env.TMPDIR = TEMP_DIR;
process.env.TEMP = TEMP_DIR;
process.env.TMP = TEMP_DIR;

// ─── Express health server (starts first for Railway) ───
const app = express();
const healthStatus = { status: 'starting', uptime: 0, telegram: false, whatsapp: 0 };

try {
  const { execSync } = require('child_process');
  healthStatus.sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  healthStatus.sha = 'n/a';
}

app.get('/', (req, res) => res.send('✅ WhatsApp Automation Bot is running!'));
app.get('/health', (req, res) => {
  healthStatus.uptime = process.uptime();
  res.json(healthStatus);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  LOG.info(`Server listening on port ${PORT}`);
  healthStatus.status = 'running';
});

server.timeout = 120000;
server.keepAliveTimeout = 65000;

// ─── Start everything ───
async function start() {
  try {
    const settings = require('./settings');
    const tgBot = require('./modules/telegramBot');
    const wa = require('./modules/whatsappManager');
    const broadcastService = require('./modules/broadcastService');

    const TELEGRAM_TOKEN = settings.telegramToken;
    if (!TELEGRAM_TOKEN) {
      LOG.error('TELEGRAM_TOKEN not set!');
      return;
    }

    // Start Telegram bot (idempotent — never creates duplicate instances)
    tgBot.startBot(TELEGRAM_TOKEN);
    LOG.info('Telegram bot started');
    healthStatus.telegram = true;

    // Auto-reconnect previously stored WhatsApp sessions
    setTimeout(async () => {
      try {
        await autoReconnect(wa);
      } catch (e) {
        LOG.error('Auto-reconnect:', e.message);
      }
      // Recover bulk-message jobs that were running when the process stopped,
      // and purge very old finished jobs (retention).
      try {
        broadcastService.purgeOldJobs();
        const resumed = broadcastService.recoverAndResume();
        if (resumed > 0) LOG.info(`Resumed ${resumed} interrupted broadcast job(s)`);
      } catch (e) {
        LOG.error('Job recovery error:', e.message);
      }
    }, 3000);

    // Whenever any WhatsApp socket connects, resume interrupted jobs.
    wa.onConnected(() => {
      try {
        broadcastService.resumeInterruptedJobs();
      } catch (e) {
        LOG.error('Job resume hook error:', e.message);
      }
    });

    // Watchdog for dead connections
    wa.startConnectionWatchdog();

    // GC every 60s (best effort)
    setInterval(() => {
      try {
        if (global.gc) global.gc();
      } catch {}
    }, 60000);

    // Temp cleanup every 5 min (orphaned downloads)
    setInterval(() => {
      try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const f of files) {
          try {
            const fp = path.join(TEMP_DIR, f);
            if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
          } catch {}
        }
      } catch {}
    }, 300000);

    LOG.info('Bot is running! 24/7 Active Mode');
    LOG.info('WhatsApp Automation Bot v' + settings.version);

    // Realtime auto-update (checks GitHub every 5 min)
    try {
      const { startAutoUpdate } = require('./lib/autoUpdater');
      startAutoUpdate();
    } catch (e) {
      LOG.warn('Auto-updater:', e.message);
    }
  } catch (err) {
    LOG.error('Startup error:', err.message, err.stack);
  }
}

async function autoReconnect(wa) {
  const sessionsData = wa.sessionsData || {};
  const sessionsDir = path.join(__dirname, 'sessions');
  let reconnected = false;

  const entries = Object.entries(sessionsData);
  for (const [phone, session] of entries) {
    if (['connected', 'reconnecting', 'disconnected'].includes(session.status)) {
      LOG.info(`Auto-reconnecting to +${phone}...`);
      try {
        await wa.connectWithPhone(phone, session.method || 'pair', null, null);
        reconnected = true;
        healthStatus.whatsapp++;
        LOG.info(`Auto-reconnected +${phone}`);
      } catch (e) {
        LOG.error(`Reconnect failed for +${phone}:`, e.message);
      }
    }
  }

  try {
    if (fs.existsSync(sessionsDir)) {
      const dirs = fs.readdirSync(sessionsDir);
      for (const dir of dirs) {
        if (dir === 'sessions.json' || dir.startsWith('.')) continue;
        const authPath = path.join(sessionsDir, dir, 'creds.json');
        if (fs.existsSync(authPath)) {
          const phone = dir.replace(/[^0-9]/g, '');
          if (phone && (!sessionsData[phone] || sessionsData[phone]?.status !== 'connected')) {
            if (!sessionsData[phone]) sessionsData[phone] = { phone, status: 'reconnecting' };
            else sessionsData[phone].status = 'reconnecting';
            LOG.info(`Found stored auth for ${dir}, reconnecting...`);
            try {
              await wa.connectWithPhone(phone, 'pair', null, null);
              reconnected = true;
              healthStatus.whatsapp++;
              LOG.info(`Auto-reconnected ${dir}`);
            } catch (e) {
              LOG.error(`Reconnect failed for ${dir}:`, e.message);
            }
          }
        }
      }
    }
  } catch (e) {
    LOG.warn('No sessions to auto-reconnect:', e.message);
  }

  if (!reconnected) LOG.info('No previous WhatsApp sessions found. Use Telegram to connect.');
}

start();

// ─── Graceful shutdown ───
async function gracefulShutdown(signal) {
  LOG.info(`Received ${signal} — shutting down...`);
  healthStatus.status = 'shutdown';
  try { server.close(); } catch {}
  try {
    const wa = require('./modules/whatsappManager');
    wa.saveSessionsData();
    const broadcastService = require('./modules/broadcastService');
    broadcastService.shutdown();
    for (const [, sock] of Object.entries(wa.activeConnections || {})) {
      try { sock?.end(new Error('Shutdown')); } catch {}
    }
  } catch {}
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => LOG.error('Uncaught:', err.message, err.stack));
process.on('unhandledRejection', (reason) => LOG.error('Unhandled:', reason?.message || reason));
