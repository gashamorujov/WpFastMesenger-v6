const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPicker, selectionSummary, CONTACTS_PER_PAGE } = require('../lib/picker');

test('buildPicker paginates and keeps rows <= 8', () => {
  const contacts = Array.from({ length: 17 }, (_, i) => ({
    name: `Kontakt ${i}`,
    phone: `99450${String(1234567 + i).padStart(7, '0')}`,
    waRegistered: null,
  }));
  const p = buildPicker(contacts, new Set(), 2);
  assert.equal(p.keyboard.length, 8);
  assert.equal(p.text.includes('3/4'), true);

  // 5 contacts per page → page 2 shows items 10..14
  const page1 = buildPicker(contacts, new Set(), 1);
  const toggles = page1.keyboard.flat().filter((b) => b.callback_data.startsWith('sp:toggle'));
  assert.equal(toggles.length, CONTACTS_PER_PAGE);
  assert.equal(toggles[0].callback_data, 'sp:toggle:994501234572'); // page 1 → items 5..9
});

test('buildPicker reflects selection with checked marks', () => {
  const contacts = [{ name: 'A', phone: '994501234567', waRegistered: 'yes' }];
  const p = buildPicker(contacts, new Set(['994501234567']), 0);
  assert.match(p.keyboard[1][0].text, /☑️/);
  assert.match(p.keyboard[1][0].text, /🟢/);
  assert.match(p.text, /Seçilib: 1/);
});

test('selectionSummary lists names + numbers', () => {
  const s = selectionSummary([
    { name: 'Akif', phone: '994773648648' },
    { phone: '994501234567' },
  ]);
  assert.match(s, /Akif — \+994 77 364 86 48/);
  assert.match(s, /\+994 50 123 45 67/);
});
