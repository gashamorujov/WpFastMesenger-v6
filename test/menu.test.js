const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAIN_MENU_BUTTONS,
  CONNECTION_MENU_BUTTONS,
  CONTACTS_MENU_BUTTONS,
  DATABASE_MENU_BUTTONS,
  SS_CONFIRM_BUTTONS,
  SS_STOP_BUTTONS,
  resultButtons,
  resultButtonsWithAgain,
} = require('../lib/menu');

const texts = (rows) => rows.flat().map((b) => b.text).join(' | ');
const data = (rows) => rows.flat().map((b) => b.callback_data);

test('main menu — has .rr, no Reconnect, no 🛑 Dayandır, has ⛔ ləğv', () => {
  const t = texts(MAIN_MENU_BUTTONS);
  assert.match(t, /📇 Kontakt Əlavə Et/);
  assert.match(t, /📒 Kontaktlar/);
  assert.match(t, /📨 Toplu Mesaj/);
  assert.match(t, /📲 Qoşul/);
  assert.match(t, /⛔ Prosesi ləğv et/);
  assert.doesNotMatch(t, /Reconnect/i);
  assert.doesNotMatch(t, /🛑/);
  assert.ok(data(MAIN_MENU_BUTTONS).includes('.rr'));
  assert.ok(data(MAIN_MENU_BUTTONS).includes('cc'));
  assert.ok(!data(MAIN_MENU_BUTTONS).includes('reconnect'));
});

test('connection menu — QR + Pair, Reconnect yoxdur', () => {
  assert.ok(data(CONNECTION_MENU_BUTTONS).includes('pair'));
  assert.ok(data(CONNECTION_MENU_BUTTONS).includes('qr'));
  assert.ok(data(CONNECTION_MENU_BUTTONS).includes('logout'));
  assert.ok(!data(CONNECTION_MENU_BUTTONS).includes('reconnect'));
});

test('kontaktlar menyusu — Düzəliş et / Database', () => {
  const t = texts(CONTACTS_MENU_BUTTONS);
  assert.match(t, /✏️ Düzəliş et/);
  assert.match(t, /🗄 Database/);
  const d = data(CONTACTS_MENU_BUTTONS);
  assert.ok(d.includes('ct:edit'));
  assert.ok(d.includes('ct:db'));
});

test('database menyusu — Kontakta əlavə et / Geri', () => {
  const t = texts(DATABASE_MENU_BUTTONS);
  assert.match(t, /➕ Kontakta əlavə et/);
  const d = data(DATABASE_MENU_BUTTONS);
  assert.ok(d.includes('ct:sync'));
  assert.ok(d.includes('ct:menu'));
});

test('🛑 Dayandır — tam genişlikdə tək düymə (sp:stop)', () => {
  assert.equal(SS_STOP_BUTTONS.length, 1);
  assert.equal(SS_STOP_BUTTONS[0].length, 1);
  assert.equal(SS_STOP_BUTTONS[0][0].callback_data, 'sp:stop');
  assert.match(SS_STOP_BUTTONS[0][0].text, /🛑 Göndərişi Dayandır/);
});

test('təsdiq ekranı — 🚀 Göndər tam genişlikdə', () => {
  assert.equal(SS_CONFIRM_BUTTONS[0].length, 1);
  assert.equal(SS_CONFIRM_BUTTONS[0][0].callback_data, 'sp:send');
  assert.equal(SS_CONFIRM_BUTTONS[0][0].text, '🚀 Göndər');
});

test('nəticə düymələri — retry + again + menyu', () => {
  const r = resultButtons('j1');
  assert.ok(data(r).includes('sp:retry:j1'));
  assert.ok(data(r).includes('menu'));
  const a = resultButtonsWithAgain('j1', 'j2');
  assert.ok(data(a).includes('sp:again:j2'));
  assert.equal(a[0][0].text, '📨 Yenidən göndər');
});
