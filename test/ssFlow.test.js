const { isolateDataDir } = require('./helpers');
isolateDataDir('ssflow');
const test = require('node:test');
const assert = require('node:assert/strict');

const { sessionManager, setTelegramMessenger } = require('../modules/services');
const { STATES } = require('../modules/sessionManager');
const jobStore = require('../modules/jobStore');
const contactStore = require('../modules/contactStore');
const wa = require('../modules/whatsappManager');
const broadcastService = require('../modules/broadcastService');
const ss = require('../commands/ss');

const originalCreateJob = broadcastService.createJob;
const originalRetryFailed = broadcastService.retryFailed;
let lastJob = null;
const deletedMsgs = [];

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
    messageId: 99,
  };
}

test.before(() => {
  jobStore._reset();
  contactStore._reset();
  setTelegramMessenger({
    sendText: async () => ({}),
    deleteMessage: async (chatId, mid) => { deletedMsgs.push(mid); return true; },
  });
  wa.getSenderSocket = () => ({ sock: { sendMessage: async () => ({}) }, phone: '994501234567' });
  broadcastService.createJob = (input) => {
    lastJob = { ...input, id: 'job-fake' };
    return lastJob;
  };
  broadcastService.retryFailed = (jobId, progressMsgId) => ({ id: 'retry-fake', targets: [{ phone: '994551234567' }] });
});

test.after(() => {
  broadcastService.createJob = originalCreateJob;
  broadcastService.retryFailed = originalRetryFailed;
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12']) sessionManager.destroy(id);
});

test('ss.start — numbers prompt + SS_NUMBERS state', async () => {
  const chat = fakeChat();
  await ss.start('c1', chat);
  assert.equal(sessionManager.get('c1').state, STATES.SS_NUMBERS);
  assert.match(chat.sent[0].text, /Nömrələri daxil edin/);
  assert.match(chat.sent[0].text, /503482690/);
});

test('ss.handle — manual numbers phase → content phase', async () => {
  const chat = fakeChat();
  await ss.start('c2', chat);
  let ok = await ss.handle('c2', { text: '0501234567\n055 987 65 43' }, '0501234567\n055 987 65 43', chat, () => ({}));
  assert.equal(ok, true);
  const s = sessionManager.get('c2');
  assert.equal(s.state, STATES.SS_CONTENT);
  assert.equal(s.numbers.length, 2);
  assert.equal(s.numbers[1].phone, '994559876543');

  // content phase: numbers-only text appends
  ok = await ss.handle('c2', { text: '0773648648' }, '0773648648', chat, () => ({}));
  assert.equal(ok, true);
  assert.equal(s.numbers.length, 3);
});

test('ss.handle — rejects non-number text during numbers phase', async () => {
  const chat = fakeChat();
  await ss.start('c3', chat);
  await ss.handle('c3', { text: 'salam' }, 'salam', chat, () => ({}));
  const s = sessionManager.get('c3');
  assert.equal(s.state, STATES.SS_NUMBERS);
  const last = chat.edited[chat.edited.length - 1] || chat.sent[chat.sent.length - 1];
  assert.match(last.text, /Nömrə tapılmadı/);
});

test('ss.handle — content message → confirm screen with 🚀 Göndər', async () => {
  const chat = fakeChat();
  await ss.start('c4', chat);
  await ss.handle('c4', { text: '0501234567' }, '0501234567', chat, () => ({}));
  const ok = await ss.handle('c4', { text: 'salam dünya' }, 'salam dünya', chat, () => ({ type: 'text', payload: { text: 'salam dünya' } }));
  assert.equal(ok, true);
  const s = sessionManager.get('c4');
  assert.equal(s.state, STATES.SS_CONFIRM);
  assert.ok(s.pendingPayload);
  // Təsdiq mesajı YENİ mesaj kimi ən aşağıda göndərilir (redaktə deyil)
  assert.equal(chat.edited.length, 0);
  const last = chat.sent[chat.sent.length - 1];
  assert.match(last.text, /Hazırdır/);
  const labels = last.opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('🚀 Göndər'));
});

test('ss.handleAction — send creates a job with progressMsgId', async () => {
  const chat = fakeChat();
  await ss.start('c5', chat);
  await ss.handle('c5', { text: '0501234567' }, '0501234567', chat, () => ({}));
  await ss.handle('c5', { text: 'salam' }, 'salam', chat, () => ({ type: 'text', payload: { text: 'salam' } }));
  const s = sessionManager.get('c5');
  assert.equal(s.state, STATES.SS_CONFIRM);

  const ok = await ss.handleAction('c5', 'send', chat);
  assert.equal(ok, true);
  assert.equal(lastJob.targets.length, 1);
  assert.equal(lastJob.targets[0].phone, '994501234567');
  assert.ok(lastJob.progressMsgId); // confirm message becomes live progress
  assert.equal(sessionManager.get('c5').state, STATES.IDLE);
});

test('ss.handleAction — back returns to content phase', async () => {
  const chat = fakeChat();
  await ss.start('c6', chat);
  await ss.handle('c6', { text: '0501234567' }, '0501234567', chat, () => ({}));
  await ss.handle('c6', { text: 'salam' }, 'salam', chat, () => ({ type: 'text', payload: { text: 'salam' } }));
  const ok = await ss.handleAction('c6', 'back', chat);
  assert.equal(ok, true);
  const s = sessionManager.get('c6');
  assert.equal(s.state, STATES.SS_CONTENT);
  assert.equal(s.pendingPayload, null);
});

test('ss.handleAction — retry starts a fresh progress message', async () => {
  const chat = fakeChat();
  const old = jobStore.create({
    chatId: 'c7',
    type: 'text',
    payloadSpec: { type: 'text', text: 'x' },
    targets: [{ phone: '994551234567', name: 'B' }],
  });
  const ok = await ss.handleAction('c7', `retry:${old.id}`, chat);
  assert.equal(ok, true);
  const last = chat.sent[chat.sent.length - 1];
  assert.match(last.text, /Yenidən göndərilir/);
  const labels = last.opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((l) => l.includes('🛑')));
});

test('ss.handleAction — stop cancels and resets the session', async () => {
  const chat = fakeChat();
  await ss.start('c9', chat);
  const ok = await ss.handleAction('c9', 'stop', chat);
  assert.equal(ok, true);
  assert.equal(sessionManager.get('c9').state, STATES.IDLE);
  assert.equal(sessionManager.get('c9').numbers.length, 0);
});

test('ss.handleAction — again re-enters content with previous numbers', async () => {
  const chat = fakeChat();
  const old = jobStore.create({
    chatId: 'c8',
    type: 'text',
    payloadSpec: { type: 'text', text: 'x' },
    targets: [{ phone: '994551234567', name: 'B' }],
  });
  const ok = await ss.handleAction('c8', `again:${old.id}`, chat);
  assert.equal(ok, true);
  const s = sessionManager.get('c8');
  assert.equal(s.state, STATES.SS_CONTENT);
  assert.equal(s.numbers.length, 1);
  assert.equal(s.numbers[0].phone, '994551234567');
});

test('ss.handle — exact user input (994503482690 / +994 51 414 34 32) → both numbers reach the job', async () => {
  const chat = fakeChat();
  await ss.start('c10', chat);
  await ss.handle('c10', { text: '994503482690\n+994 51 414 34 32' }, '994503482690\n+994 51 414 34 32', chat, () => ({}));
  const s = sessionManager.get('c10');
  assert.equal(s.state, STATES.SS_CONTENT);
  assert.equal(s.numbers.length, 2);
  assert.deepEqual(s.numbers.map((n) => n.phone), ['994503482690', '994514143432']);

  await ss.handle('c10', { text: 'test mesajı' }, 'test mesajı', chat, () => ({ type: 'text', payload: { text: 'test mesajı' } }));
  await ss.handleAction('c10', 'send', chat);
  assert.equal(lastJob.targets.length, 2);
  assert.deepEqual(lastJob.targets.map((t) => t.phone), ['994503482690', '994514143432']);
});

test('ss flow — bot prompts are deleted and re-sent below the user message (bottom placement)', async () => {
  deletedMsgs.length = 0;
  const chat = fakeChat();
  await ss.start('c11', chat);
  const numbersPromptId = chat.sent[0].id;

  // Nömrələr daxil edilir → köhnə sorğu silinir, yeni sorğu aşağıda göndərilir
  await ss.handle('c11', { text: '503482690\n773971757\n514143432' }, '503482690\n773971757\n514143432', chat, () => ({}));
  assert.ok(deletedMsgs.includes(numbersPromptId), 'numbers prompt deleted');
  assert.equal(chat.sent.length, 2);
  const contentPromptId = chat.sent[1].id;

  // Mesaj yazılır → "Mesajı yaz" sorğusu silinir, təsdiq YENİ mesaj kimi ən aşağıda
  await ss.handle('c11', { text: 'Salam' }, 'Salam', chat, () => ({ type: 'text', payload: { text: 'Salam' } }));
  assert.ok(deletedMsgs.includes(contentPromptId), 'content prompt deleted');
  assert.equal(chat.edited.length, 0, 'confirm is sent as a new message, not edited in place');
  assert.equal(chat.sent.length, 3);
  assert.match(chat.sent[2].text, /Hazırdır/);
});

test('ss.handle — exact 3-line input (503482690 / 773971757 / 514143432) → 3 separate recipients in the job', async () => {
  const chat = fakeChat();
  await ss.start('c12', chat);
  await ss.handle('c12', { text: '503482690\n773971757\n514143432' }, '503482690\n773971757\n514143432', chat, () => ({}));
  const s = sessionManager.get('c12');
  assert.equal(s.state, STATES.SS_CONTENT);
  assert.equal(s.numbers.length, 3);
  assert.deepEqual(s.numbers.map((n) => n.phone), ['994503482690', '994773971757', '994514143432']);

  await ss.handle('c12', { text: 'Salam' }, 'Salam', chat, () => ({ type: 'text', payload: { text: 'Salam' } }));
  await ss.handleAction('c12', 'send', chat);
  assert.equal(lastJob.targets.length, 3);
  assert.deepEqual(lastJob.targets.map((t) => t.phone), ['994503482690', '994773971757', '994514143432']);
});
