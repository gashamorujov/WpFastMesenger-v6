/**
 * menu — shared inline-keyboard layouts for the Telegram bot.
 *
 * MAIN_MENU_BUTTONS       — shown on /start and after any session cleanup
 *                           (Qeydiyyat, .rr, .ss, .cc)
 * CONNECTION_MENU_BUTTONS — opened by the Qeydiyyat button
 *                           (Pair Code, Reconnect, Log Out, back to menu)
 * SS_START_BUTTONS        — .ss prompt: contact picker or manual entry
 */
const MAIN_MENU_BUTTONS = [
  [{ text: '📲 Qeydiyyat — WhatsApp-a qoşul', callback_data: '.gg' }],
  [
    { text: '📇 .rr — Kontaktlar', callback_data: '.rr' },
    { text: '📨 .ss — Toplu mesaj', callback_data: '.ss' },
  ],
  [{ text: '⛔ .cc — Ləğv et', callback_data: '.cc' }],
];

const CONNECTION_MENU_BUTTONS = [
  [{ text: '🔐 Pair Code — yeni qoşulma', callback_data: 'pair' }],
  [{ text: '🔄 Reconnect', callback_data: 'reconnect' }],
  [{ text: '🚪 Log Out', callback_data: 'logout' }],
  [{ text: '↩️ Əsas menyu', callback_data: 'menu' }],
];

const SS_START_BUTTONS = [
  [
    { text: '📇 Kontaktlardan seç', callback_data: 'sp:start' },
    { text: '✏️ Əl ilə daxil et', callback_data: 'sp:manual' },
  ],
];

module.exports = { MAIN_MENU_BUTTONS, CONNECTION_MENU_BUTTONS, SS_START_BUTTONS };
