/**
 * SessionManager — per-chat user sessions.
 *
 * Every chat (Telegram chat id or WhatsApp remoteJid) gets its own isolated
 * session, so multiple users can run .rr / .ss / .gg at the same time
 * without interfering. A session tracks:
 *
 *  - FSM state (idle / rr / ss_numbers / ss_content / gg_collecting / ...)
 *  - per-flow queues (rr / ss / gg) — sequential, cancellable
 *  - temporary media files (cleaned on cancel / reset)
 *  - idle expiry timer (memory safety)
 */
const fs = require('fs-extra');
const { makeLogger } = require('./logger');

const LOG = makeLogger('SESSION');

const STATES = {
  IDLE: 'idle',
  RR: 'rr',
  SS_NUMBERS: 'ss_numbers',
  SS_CONTENT: 'ss_content',
  SS_CONFIRM: 'ss_confirm',
  CT_RENAME: 'ct_rename',
  CT_NUMBER: 'ct_number',
  BUSY: 'busy',
};

const IDLE_TTL_MS = 30 * 60 * 1000; // sessions auto-expire after 30 min

class Session {
  constructor(chatId) {
    this.chatId = chatId;
    this.state = STATES.IDLE;
    this.flow = null;           // 'pair' when waiting for a phone number in Telegram
    this.msgId = null;          // Telegram prompt message id (cleanup helper)
    this.contacts = [];         // .rr validated contacts (pending + processed markers)
    this.numbers = [];          // .ss targets [{phone, name?}] (normalized, E.164)
    this.pendingPayload = null; // .ss built payload awaiting 🚀 Göndər confirmation
    this.jobId = null;          // .ss job currently started from this chat
    this.ctPhone = null;        // contact being edited (rename / change number)
    this.botMsgs = [];          // bot prompt message ids cleaned on next action
    this.contentCount = 0;      // .ss content items queued
    this.tempFiles = [];        // downloaded media temp files
    this.timer = null;          // idle expiry timer
    this.aborted = false;

    this.rrQueue = null;        // Queue for .rr contact-add jobs
    this.ssQueue = null;        // Queue for .ss broadcast jobs
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  get(chatId) {
    let s = this.sessions.get(chatId);
    if (!s) {
      s = new Session(chatId);
      this.sessions.set(chatId, s);
    }
    return s;
  }

  /** Refresh the idle-expiry timer for a chat. */
  touch(chatId) {
    const s = this.get(chatId);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      LOG.info(`Session ${chatId} expired (idle), resetting`);
      this.cancel(chatId);
    }, IDLE_TTL_MS);
  }

  /**
   * Hard cancel: abort any active work, clear queues and FSM state, delete
   * temp files. Used by the .cc command (works at any stage, anywhere).
   * @returns {boolean} true if a session existed
   */
  cancel(chatId) {
    const s = this.sessions.get(chatId);
    if (!s) return false;

    s.aborted = true;
    for (const q of [s.rrQueue, s.ssQueue]) {
      if (q) q.cancel();
    }

    s.rrQueue = null;
    s.ssQueue = null;
    s.flow = null;
    s.msgId = null;
    s.contacts.length = 0;
    s.numbers.length = 0;
    s.contentCount = 0;
    s.pendingPayload = null;
    s.jobId = null;
    s.ctPhone = null;

    // botMsgs qəsdən təmizlənmir: köhnə bot mesajlarının silinməsi
    // collectBotMsgs() ilə (mesajlar silindikdən sonra) həyata keçirilir.

    this.clearTempFiles(chatId);

    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.state = STATES.IDLE;
    return true;
  }

  /** Reset FSM state to idle (keeps the session object alive). */
  reset(chatId) {
    const s = this.get(chatId);
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.state = STATES.IDLE;
    s.aborted = false;
  }

  /** Track a temp file so it can be cleaned up later. */
  trackTempFile(chatId, filePath) {
    if (!filePath) return;
    const s = this.get(chatId);
    s.tempFiles.push(filePath);
  }

  /** Remove all temp files belonging to a chat. */
  clearTempFiles(chatId) {
    const s = this.sessions.get(chatId);
    if (!s) return;
    for (const f of s.tempFiles) {
      try { fs.removeSync(f); } catch {}
    }
    s.tempFiles.length = 0;
  }
  /**
   * Return and clear all tracked bot message ids (prompt / intermediate
   * messages). The caller deletes them after the operation completes.
   * @param {string} chatId
   * @returns {number[]}
   */
  collectBotMsgs(chatId) {
    const s = this.sessions.get(chatId);
    if (!s) return [];
    const ids = s.botMsgs.slice();
    s.botMsgs.length = 0;
    return ids;
  }

  /** Drop the session entirely (frees memory). */
  destroy(chatId) {
    const s = this.sessions.get(chatId);
    if (!s) return;
    this.cancel(chatId);
    this.sessions.delete(chatId);
  }
}

module.exports = { SessionManager, Session, STATES };
