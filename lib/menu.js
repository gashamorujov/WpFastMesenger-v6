/**
 * menu — creative, short, emoji-based inline keyboards.
 *
 * Buttons are intentionally short and mobile-friendly:
 *   📒 Kontaktlar • 📇 Kontakt Əlavə Et • 📨 Toplu Mesaj • 📲 Qoşul
 *   🚀 Göndər • 🛑 Göndərişi Dayandır • ⛔ Prosesi ləğv et
 *   ✏️ Düzəliş et • 🗄 Database • 🔐 Pair Code • 📷 QR Code
 *
 * 🛑 Dayandır YALNIZ aktiv toplu göndəriş zamanı görünür (SS_STOP_BUTTONS);
 * əsas menyuda göstərilmir. ⛔ Prosesi ləğv et YALNIZ .ss / .gg / .rr axın
 * sorğularında görünür və .cc ilə eyni işi görür (aktiv prosesi dayandırır,
 * müvəqqəti məlumatları təmizləyir, əsas menyuya qaytarır).
 */
const MAIN_MENU_BUTTONS = [
  [{ text: '📒 Kontaktlar', callback_data: 'ct:menu' }],
  [{ text: '📇 Kontakt Əlavə Et', callback_data: '.rr' }],
  [{ text: '📨 Toplu Mesaj', callback_data: '.ss' }],
  [{ text: '📲 Qoşul', callback_data: '.gg' }],
];

const CONNECTION_MENU_BUTTONS = [
  [{ text: '🔐 Pair Code', callback_data: 'pair' }],
  [{ text: '📷 QR Code', callback_data: 'qr' }],
  [{ text: '🚪 Çıxış', callback_data: 'logout' }],
  [{ text: '↩️ Geri', callback_data: 'menu' }],
];

// 📒 Kontaktlar bölməsi: Düzəliş et (mövcud brauzer) / Database (sinxron)
const CONTACTS_MENU_BUTTONS = [
  [{ text: '✏️ Düzəliş et', callback_data: 'ct:edit' }],
  [{ text: '🗄 Database', callback_data: 'ct:db' }],
  [{ text: '↩️ Geri', callback_data: 'menu' }],
];

// 🗄 Database menyusu
const DATABASE_MENU_BUTTONS = [
  [{ text: '➕ Kontakta əlavə et', callback_data: 'ct:sync' }],
  [{ text: '↩️ Geri', callback_data: 'ct:menu' }],
];

// Geniş ləğv düyməsi (.cc ilə eyni funksiya)
const CANCEL_BUTTON = [[{ text: '⛔ Prosesi ləğv et', callback_data: 'cc' }]];

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
  CONTACTS_MENU_BUTTONS,
  DATABASE_MENU_BUTTONS,
  CANCEL_BUTTON,
  SS_CONFIRM_BUTTONS,
  SS_STOP_BUTTONS,
  MENU_BUTTON,
  resultButtons,
  resultButtonsWithAgain,
};
