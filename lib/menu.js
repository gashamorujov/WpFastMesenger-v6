/**
 * menu — creative, short, emoji-based inline keyboards.
 *
 * Buttons are intentionally short and mobile-friendly:
 *   🚀 Göndər • 🛑 Dayandır • 📒 Kontaktlar • ✏️ Dəyiş • 🔢 Nömrə
 *   🗑 Sil • 👁 Məlumat • 🔄 Reconnect • ↩️ Geri • 🏠 Menyu
 */
const MAIN_MENU_BUTTONS = [
  [{ text: '📒 Kontaktlar', callback_data: 'ct:open' }],
  [{ text: '📨 Toplu Mesaj', callback_data: '.ss' }],
  [
    { text: '📲 Qoşul', callback_data: '.gg' },
    { text: '🔄 Reconnect', callback_data: 'reconnect' },
  ],
  [{ text: '🛑 Dayandır', callback_data: '.cc' }],
];

const CONNECTION_MENU_BUTTONS = [
  [{ text: '🔐 Pair Code', callback_data: 'pair' }],
  [{ text: '🔄 Reconnect', callback_data: 'reconnect' }],
  [{ text: '🚪 Çıxış', callback_data: 'logout' }],
  [{ text: '↩️ Geri', callback_data: 'menu' }],
];

// .ss confirmation screen
const SS_CONFIRM_BUTTONS = [
  [
    { text: '🚀 Göndər', callback_data: 'sp:send' },
    { text: '✖️ Geri', callback_data: 'sp:back' },
  ],
];

// Live stop button shown while a broadcast is running
const SS_STOP_BUTTONS = [[{ text: '🛑 Dayandır', callback_data: 'sp:stop' }]];

const MENU_BUTTON = [[{ text: '🏠 Menyu', callback_data: 'menu' }]];

/**
 * Keyboard for the final broadcast result.
 * @param {string|null} retryJobId — shows a retry button when failures exist
 */
function resultButtons(retryJobId = null) {
  const rows = [];
  if (retryJobId) rows.push([{ text: '🔁 Uğursuzları təkrar', callback_data: `sp:retry:${retryJobId}` }]);
  rows.push([{ text: '🏠 Menyu', callback_data: 'menu' }]);
  return rows;
}

/** Keyboard with a "send a new message to the same list" action. */
function resultButtonsWithAgain(retryJobId = null, againJobId = null) {
  const rows = resultButtons(retryJobId);
  if (againJobId) rows.unshift([{ text: '📨 Yenidən göndər', callback_data: `sp:again:${againJobId}` }]);
  return rows;
}

module.exports = {
  MAIN_MENU_BUTTONS,
  CONNECTION_MENU_BUTTONS,
  SS_CONFIRM_BUTTONS,
  SS_STOP_BUTTONS,
  MENU_BUTTON,
  resultButtons,
  resultButtonsWithAgain,
};
