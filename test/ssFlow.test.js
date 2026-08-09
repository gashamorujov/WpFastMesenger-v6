const { isolateDataDir } = require('./helpers');
isolateDataDir('ssflow');
const test = require('node:test');
const assert = require('node:assert/strict');

const { sessionManager } = require('../modules/services');
const { STATES } = require('../modules/sessionManager');
const contactStore = require('../modules/contactStore');
const ss = require('../commands/ss');

test.before(() => {
  contactStore._reset();
  contactStore.upsert({ name: 'Akif Babayev', phone: '0773648648' });
  contactStore.upsert({ name: 'Zəhra', phone: '0501234567' });
  contactStore.upsert({ name: 'Rəşad', phone: '0559876543' });
});

function fakeChat() {
  const sent = [];
  const edited = [];
  return {
    sent,
    edited,
    send: async (text, opts) => { sent.push({ text, opts }); return { message_id: sent.length }; },
    edit: async (chatId, msgId, text, opts) => { edited.push({ msgId, text }); },
  };
}

test.after(() => {
  for (const id of ['c1', 'c2', 'c3', 'c4']) sessionManager.destroy(id);
});

test('picker — start, toggle, all, done flow', async () => {
  const chat = fakeChat();
  await ss.pickerAction('c1', 'start', chat.send, chat.edit);
  assert.equal(sessionManager.get('c1').state, STATES.SS_NUMBERS);
  assert.match(chat.sent[0].text, /Kontaktlardan seçin/);

  // toggle one contact
  await ss.pickerAction('c1', 'toggle:994773648648', chat.send, chat.edit);
  let s = sessionManager.get('c1');
  assert.equal(s.numbers.length, 1);
  assert.equal(s.numbers[0].name, 'Akif Babayev');
  assert.equal(chat.edited.length, 1);

  // select all
  await ss.pickerAction('c1', 'all', chat.send, chat.edit);
  s = sessionManager.get('c1');
  assert.equal(s.numbers.length, 3);

  // deselect all
  await ss.pickerAction('c1', 'none', chat.send, chat.edit);
  s = sessionManager.get('c1');
  assert.equal(s.numbers.length, 0);

  // select all again and finish
  await ss.pickerAction('c1', 'all', chat.send, chat.edit);
  await ss.pickerAction('c1', 'done', chat.send, chat.edit);
  s = sessionManager.get('c1');
  assert.equal(s.state, STATES.SS_CONTENT);
  const doneMsg = chat.sent[chat.sent.length - 1].text;
  assert.match(doneMsg, /Seçildi \(3\)/);
  assert.match(doneMsg, /Akif Babayev — \+994 77 364 86 48/);
});

test('picker — done with no selection warns', async () => {
  const chat = fakeChat();
  await ss.pickerAction('c2', 'start', chat.send, chat.edit);
  await ss.pickerAction('c2', 'done', chat.send, chat.edit);
  const s = sessionManager.get('c2');
  assert.equal(s.state, STATES.SS_NUMBERS); // stays in picker phase
  assert.match(chat.sent[chat.sent.length - 1].text, /Heç bir nömrə seçilməyib/);
});

test('ss.handle — manual numbers phase → content phase', async () => {
  const chat = fakeChat();
  await ss.start('c3', chat.send, '');
  let ok = await ss.handle('c3', { text: '0501234567\n055 987 65 43' }, '0501234567\n055 987 65 43', chat.send, () => ({}));
  assert.equal(ok, true);
  const s = sessionManager.get('c3');
  assert.equal(s.state, STATES.SS_CONTENT);
  assert.equal(s.numbers.length, 2);
  assert.equal(s.numbers[1].phone, '994559876543');

  // content phase: numbers-only text appends
  ok = await ss.handle('c3', { text: '0773648648' }, '0773648648', chat.send, () => ({}));
  assert.equal(ok, true);
  assert.equal(s.numbers.length, 3);
});

test('ss.handle — rejects non-number text during numbers phase', async () => {
  const chat = fakeChat();
  await ss.start('c4', chat.send, '');
  await ss.handle('c4', { text: 'salam' }, 'salam', chat.send, () => ({}));
  assert.match(chat.sent[chat.sent.length - 1].text, /Yalnız nömrələr/);
});
