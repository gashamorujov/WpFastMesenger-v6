const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContactList, buildContactActions, buildContactInfo, CONTACTS_PER_PAGE } = require('../lib/contactBrowser');

const mk = (i) => ({ name: `Kontakt ${i}`, phone: `99450${String(1234567 + i).padStart(7, '0')}`, waRegistered: null });

test('buildContactList paginates and keeps rows = 5 + nav + search + back', () => {
  const contacts = Array.from({ length: 17 }, (_, i) => mk(i));
  const p = buildContactList(contacts, 2);
  assert.equal(p.keyboard.length, 8); // 5 contacts + page nav + search + back
  assert.match(p.text, /3\/4/);
  const page1 = buildContactList(contacts, 1);
  const toggles = page1.keyboard.flat().filter((b) => b.callback_data.startsWith('ct:view'));
  assert.equal(toggles.length, CONTACTS_PER_PAGE);
  assert.ok(page1.keyboard.flat().some((b) => b.callback_data === 'ct:search'));
});

test('buildContactList shows WA badge and empty state', () => {
  const p = buildContactList([{ name: 'A', phone: '994501234567', waRegistered: 'yes' }], 0);
  assert.match(p.keyboard[0][0].text, /✅/);
  const empty = buildContactList([], 0);
  assert.match(empty.text, /Baza boşdur/);
});

test('buildContactActions + buildContactInfo', () => {
  const c = { name: 'Akif Babayev', phone: '994773648648', waRegistered: null, addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const a = buildContactActions(c);
  assert.match(a.text, /Akif Babayev/);
  const labels = a.keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('🗑 Sil'));
  assert.ok(labels.includes('👁 Məlumat'));
  const info = buildContactInfo(c);
  assert.match(info, /\+994 77 364 86 48/);
});
