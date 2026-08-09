/**
 * menu — creative, short, emoji-based inline keyboards.
 *
 * Buttons are intentionally short and mobile-friendly:
 *   📒 Kontaktlar • 📇 Kontakt Əlavə Et • 📨 Toplu Mesaj • 📲 Qoşul
 *   🚀 Göndər • 🛑 Göndərişi Dayandır • ✏️ Dəyiş • 🔢 Nömrə
 *   🗑 Sil • 👁 Məlumat • 🔄 Reconnect • ↩️ Geri • 🏠 Menyu
 *
 * 🛑 Dayandır YALNIZ aktiv toplu göndəriş zamanı görünür (SS_STOP_BUTTONS);
 * əsas menyuda və digər ekranlarda göstərilmir. Reconnect isə yalnız
 * qoşulma (CONNECTION_MENU_BUTTONS) bölməsindədir.
 */
const MAIN_MENU_BUTTONS = [
  [{ text: '📒 Kontaktlar', callback_data: 'ct:open' }],
  [{ text: '📇 Kontakt Əlavə Et', callback_data: '.rr' }],
  [{ text: '📨 Toplu Mesaj', callback_data: '.ss' }],
  [{ text: '📲 Qoşul', callback_data: '.gg' }],
];

const CONNECTION_MENU_BUTTONS = [
  [{ text: '🔐 Pair Code', callback_data: 'pair' }],
  [{ text: '🔄 Reconnect', callback_data: 'reconnect' }],
  [{ text: '🚪 Çıxış', callback_data: 'logout' }],
  [{ text: '↩️ Geri', callback_data: 'menu' }],
];

// .ss confirmation screen — 🚀 Göndər tam genişlikdə
const SS_CONFIRM_BUTTONS = [
  [{ text: '🚀 Göndər', callback_data: 'sp:send' }],
  [{ text: '✖️ Geri', callback_data: 'sp:back' }],
];

// Live stop button — yalnız aktiv göndəriş zamanı, tam genişlikdə
const SS_STOP_BUTTONS = [[{ text: '🛑 Göndərişi Dayandır', callback_data: 'sp:stop' }]];

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
