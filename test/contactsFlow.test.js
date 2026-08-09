const { isolateDataDir } = require('./helpers');
isolateDataDir('contactsflow');
const test = require('node:test');
const assert = require('node:assert/strict');

const { sessionManager } = require('../modules/services');
const { STATES } = require('../modules/sessionManager');
const contactStore = require('../modules/contactStore');
const contacts = require('../commands/contacts');

function fakeChat() {
  const sent = [];
  const edited = [];
  const deleted = [];
  let id = 0;
  return {
    sent,
    edited,
    deleted,
    send: async (text, opts) => { id++; sent.push({ text, opts, id }); return { message_id: id }; },
    edit: async (text, opts) => { edited.push({ text, opts }); return true; },
    deleteMsg: async (cid, mid) => { deleted.push(mid); return true; },
    messageId: 7,
  };
}

test.before(() => {
  contactStore._reset();
  contactStore.upsert({ name: 'Akif Babayev', phone: '0773648648' });
  contactStore.upsert({ name: 'Zəhra', phone: '0501234567' });
});

test.after(() => {
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) sessionManager.destroy(id);
});

test('openList sends the contact list', async () => {
  const chat = fakeChat();
  await contacts.openList('c1', chat);
  assert.match(chat.sent[0].text, /📒 Kontaktlar \(2\)/);
});

test('view → rename flow with handleText', async () => {
  const chat = fakeChat();
  await contacts.openList('c2', chat);
  await contacts.handleAction('c2', 'view:994773648648', chat);
  assert.match(chat.edited[0].text, /👁/);

  await contacts.handleAction('c2', 'rename:994773648648', chat);
  let s = sessionManager.get('c2');
  assert.equal(s.state, STATES.CT_RENAME);
  assert.equal(s.ctPhone, '994773648648');

  const ok = await contacts.handleText('c2', 'Akif B.', chat);
  assert.equal(ok, true);
  assert.equal(contactStore.get('994773648648').name, 'Akif B.');
  assert.equal(sessionManager.get('c2').state, STATES.IDLE);
});

test('change-number flow with handleText', async () => {
  const chat = fakeChat();
  await contacts.openList('c3', chat);
  await contacts.handleAction('c3', 'num:994501234567', chat);
  assert.equal(sessionManager.get('c3').state, STATES.CT_NUMBER);
  await contacts.handleText('c3', '0559876543', chat);
  assert.equal(contactStore.get('994559876543').name, 'Zəhra');
  assert.equal(contactStore.get('994501234567'), null);
});

test('del removes the contact', async () => {
  const chat = fakeChat();
  await contacts.openList('c4', chat);
  await contacts.handleAction('c4', 'del:994773648648', chat);
  assert.equal(contactStore.get('994773648648'), null);
});

test('back deletes the tapped message', async () => {
  const chat = fakeChat();
  await contacts.openList('c5', chat);
  await contacts.handleAction('c5', 'back', chat);
  assert.deepEqual(chat.deleted, [7]);
});
