/**
 * Services — shared singletons wired at startup.
 *
 * sessionManager        — per-chat sessions (Telegram + WhatsApp)
 * telegramMessenger     — message adapter exposed by the Telegram module
 *                          (set once the bot starts)
 */
const { SessionManager } = require('./sessionManager');

const sessionManager = new SessionManager();

let telegramMessenger = null;
function setTelegramMessenger(m) {
  telegramMessenger = m;
}
function getTelegramMessenger() {
  return telegramMessenger;
}

module.exports = { sessionManager, setTelegramMessenger, getTelegramMessenger };
