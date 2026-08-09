const test = require('node:test');
const assert = require('node:assert/strict');
const { setTelegramMessenger } = require('../modules/services');
const incoming = require('../modules/incomingDispatcher');

let sent = [];

function makeSock() {
  const handlers = {};
  return {
    ev: {
      on: (ev, fn) => { handlers[ev] = fn; },
      off: () => {},
    },
    __handlers: handlers,
  };
}

async function emit(sock, type, messages) {
  const fn = sock.__handlers['messages.upsert'];
  assert.ok(fn, 'messages.upsert handler registered');
  await fn({ messages, type });
}

function textMsg(remoteJid, id, text, opts = {}) {
  return {
    key: { remoteJid, id, fromMe: false },
    message: { conversation: text },
    pushName: opts.pushName || null,
    messageTimestamp: Date.now() / 1000,
  };
}

test.before(() => {
  sent = [];
  setTelegramMessenger({
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; },
  });
});

test.after(() => {
  setTelegramMessenger(null);
});

test.beforeEach(() => {
  sent = [];
  incoming._reset();
});

test('forwards incoming text messages to the owning chat immediately (no broadcast)', async () => {
  const sock = makeSock();
  incoming.setChat('994501234567', 'tg-1');
  incoming.attach(sock, '994501234567');
  await emit(sock, 'notify', [textMsg('994514143432@s.whatsapp.net', 'id1', 'salam')]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'tg-1');
  assert.match(sent[0].text, /Gələn sorğu/);
  assert.match(sent[0].text, /salam/);
});

test('skips own (fromMe) messages, status broadcasts and protocol messages', async () => {
  const sock = makeSock();
  incoming.setChat('994501234567', 'tg-1');
  incoming.attach(sock, '994501234567');
  await emit(sock, 'notify', [
    { key: { remoteJid: '994514143432@s.whatsapp.net', id: 'me', fromMe: true }, message: { conversation: 'x' } },
    { key: { remoteJid: 'status@broadcast', id: 'st', fromMe: false }, message: { conversation: 'y' } },
    { key: { remoteJid: '994514143432@s.whatsapp.net', id: 'proto', fromMe: false }, message: { protocolMessage: {} } },
    { key: { remoteJid: '994514143432@s.whatsapp.net', id: 'react', fromMe: false }, message: { reactionMessage: {} } },
    { key: { remoteJid: '994514143432@s.whatsapp.net', id: 'ok', fromMe: false }, message: { conversation: 'salam' } },
  ]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /salam/);
});

test('history sync (type append) is not forwarded', async () => {
  const sock = makeSock();
  incoming.setChat('994501234567', 'tg-1');
  incoming.attach(sock, '994501234567');
  await emit(sock, 'append', [textMsg('994514143432@s.whatsapp.net', 'old1', 'köhnə mesaj')]);
  await emit(sock, 'notify', [textMsg('994514143432@s.whatsapp.net', 'new1', 'yeni mesaj')]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /yeni mesaj/);
});

test('media messages are summarized with the media type', async () => {
  const sock = makeSock();
  incoming.setChat('994501234567', 'tg-1');
  incoming.attach(sock, '994501234567');
  await emit(sock, 'notify', [
    { key: { remoteJid: '994514143432@s.whatsapp.net', id: 'img', fromMe: false }, message: { imageMessage: { caption: 'şəkil yazısı' } } },
    { key: { remoteJid: '994514143432@s.whatsapp.net', id: 'doc', fromMe: false }, message: { documentMessage: { fileName: 'sənəd.pdf' } } },
  ]);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Şəkil/);
  assert.match(sent[0].text, /şəkil yazısı/);
  assert.match(sent[1].text, /sənəd\.pdf/);
});

test('during an active broadcast incoming requests are buffered and flushed AFTER it ends (bottom)', async () => {
  const sock = makeSock();
  incoming.setChat('994501234567', 'tg-1');
  incoming.attach(sock, '994501234567');

  // Broadcast starts → pause
  incoming.pause('tg-1');
  await emit(sock, 'notify', [
    textMsg('994514143432@s.whatsapp.net', 'b1', 'cavab 1'),
    textMsg('994551234567@s.whatsapp.net', 'b2', 'cavab 2'),
  ]);
  assert.equal(sent.length, 0, 'broadcast aktivkən heç nə ötürülmür');

  // Broadcast ends → resume flushes in order, after our message
  incoming.resume('tg-1');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /cavab 1/);
  assert.match(sent[1].text, /cavab 2/);
  assert.ok(sent[0].chatId === 'tg-1' && sent[1].chatId === 'tg-1');
});

test('dedup — the same message key is forwarded only once', async () => {
  const sock = makeSock();
  incoming.setChat('994501234567', 'tg-1');
  incoming.attach(sock, '994501234567');
  const msg = textMsg('994514143432@s.whatsapp.net', 'dup-1', 'salam');
  await emit(sock, 'notify', [msg]);
  await emit(sock, 'notify', [msg]);
  assert.equal(sent.length, 1);
});

test('group chats include the group number', async () => {
  const sock = makeSock();
  incoming.setChat('994501234567', 'tg-1');
  incoming.attach(sock, '994501234567');
  await emit(sock, 'notify', [
    textMsg('1234567890@g.us', 'g1', 'qrup mesajı', { pushName: 'Rəşid' }),
  ]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /qrup/);
  assert.match(sent[0].text, /qrup mesajı/);
});
