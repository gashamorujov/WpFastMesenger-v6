const { isolateDataDir } = require('./helpers');
isolateDataDir('contactstore');
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../modules/contactStore');

test.before(() => store._reset());
test.after(() => store._reset());

test('upsert creates, updates and reports duplicates', () => {
  const a = store.upsert({ name: 'Akif Babayev', phone: '077 364 86 48' });
  assert.equal(a.created, true);
  assert.equal(a.updated, false);
  assert.equal(a.duplicate, false);

  // Same phone, same name → duplicate (no new contact)
  const b = store.upsert({ name: 'Akif Babayev', phone: '+994773648648' });
  assert.equal(b.created, false);
  assert.equal(b.duplicate, true);

  // Same phone, different name → updated in place
  const c = store.upsert({ name: 'Akif B.', phone: '994773648648' });
  assert.equal(c.created, false);
  assert.equal(c.updated, true);
  assert.equal(c.duplicate, false);

  assert.equal(store.count(), 1);
});

test('list is sorted by name', () => {
  store._reset();
  store.upsert({ name: 'Zəhra', phone: '0501234567' });
  store.upsert({ name: 'Ağa', phone: '0551234567' });
  const list = store.list();
  assert.deepEqual(list.map((c) => c.name), ['Ağa', 'Zəhra']);
});

test('search works on name and phone fragments', () => {
  const byName = store.search('ağa');
  assert.equal(byName.length, 1);
  const byPhone = store.search('1234');
  assert.ok(byPhone.length >= 1);
});

test('setWaStatus persists cached registration status', () => {
  store.setWaStatus('994551234567', 'yes');
  assert.equal(store.get('994551234567').waRegistered, 'yes');
});

test('remove deletes by any phone format', () => {
  store._reset();
  store.upsert({ name: 'X', phone: '0501234567' });
  assert.equal(store.remove('+994501234567'), true);
  assert.equal(store.count(), 0);
  assert.equal(store.remove('+994501234567'), false);
});
