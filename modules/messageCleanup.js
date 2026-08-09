/**
 * messageCleanup — bot mesajlarının izlənməsi və silinməsi.
 *
 * Əməliyyat axınlarında (sorğu / seçim / ara mərhələ) göndərilən bot
 * mesajlarının id-ləri sessiyada saxlanılır; əməliyyat tamamlananda
 * (deleteTracked) avtomatik silinir. Yalnız vacib nəticə mesajları qalır.
 */
const { sessionManager, getTelegramMessenger } = require('./services');

/** Track a bot message id so it can be auto-deleted later. */
function track(chatId, messageId) {
  if (!messageId) return;
  const s = sessionManager.get(chatId);
  if (!s.botMsgs.includes(messageId)) s.botMsgs.push(messageId);
}

/** Delete a list of message ids (best effort, never throws). */
async function deleteMessages(chatId, ids) {
  const m = getTelegramMessenger();
  if (!m || typeof m.deleteMessage !== 'function' || !ids || ids.length === 0) return;
  for (const id of ids) {
    try {
      await m.deleteMessage(chatId, id);
    } catch {}
  }
}

/** Delete all tracked bot messages for a chat and clear the tracking list. */
async function deleteTracked(chatId) {
  const ids = sessionManager.collectBotMsgs(chatId);
  await deleteMessages(chatId, ids);
}

module.exports = { track, deleteMessages, deleteTracked };
