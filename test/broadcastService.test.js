const { isolateDataDir } = require('./helpers');
isolateDataDir('broadcastservice');
const test = require('node:test');
const assert = require('node:assert/strict');

// Fast pacing so tests finish quickly (settings is read at module load)
process.env.BROADCAST_DELAY_MIN_MS = '2';
process.env.BROADCAST_DELAY_MAX_MS = '5';
process.env.BROADCAST_MAX_RETRIES = '1';

const jobStore = require('../modules/jobStore');
const contactStore = require('../modules/contactStore');
const wa = require('../modules/whatsappManager');
const { setTelegramMessenger } = require('../modules/services');
const recentSends = require('../modules/recentSends');
const waPresence = require('../modules/waPresence');
const broadcastService = require('../modules/broadcastService');
const { sleep } = require('../lib/myfunc');

test.before(() => {
  jobStore._reset();
  contactStore._reset();
  recentSends._reset();
  waPresence._resetCache();
  setTelegramMessenger({
    sendText: async () => ({ message_id: 1 }),
    editText: async () => {},
    editMessage: async () => {},
  });
});

test.beforeEach(() => {
  recentSends._reset();
  waPresence._resetCache();
});

test.after(() => {
  setTelegramMessenger(null);
  jobStore._reset();
});

async function waitTerminal(id, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = jobStore.read(id);
    if (j && (j.state === 'completed' || j.state === 'cancelled' || j.state === 'interrupted')) return j;
    await sleep(25);
  }
  throw new Error(`job ${id} did not reach a terminal state`);
}

test('createJob runs through the global queue and completes', async () => {
  const sent = [];
  wa.getSenderSocket = () => ({
    sock: {
      sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return {}; },
      onWhatsApp: async (...ps) => ps.map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: true })),
    },
    phone: '994501234567',
  });

  const job = broadcastService.createJob({
    chatId: 'chat1',
    type: 'text',
    payloadSpec: { type: 'text', text: 'salam' },
    targets: [
      { phone: '994501234567', name: 'A' },
      { phone: '994551234567', name: 'B' },
    ],
  });

  const final = await waitTerminal(job.id);
  assert.equal(final.state, 'completed');
  assert.equal(final.successCount, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.text, 'salam');
});

test('numbers not on WhatsApp are skipped (pre-check)', async () => {
  wa.getSenderSocket = () => ({
    sock: {
      sendMessage: async () => ({}),
      onWhatsApp: async (...ps) => ps.map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: p === '994501234567' })),
    },
    phone: '994501234567',
  });

  const job = broadcastService.createJob({
    chatId: 'chat1',
    type: 'text',
    payloadSpec: { type: 'text', text: 'salam' },
    targets: [
      { phone: '994501234567' },
      { phone: '994551234567' }, // not registered
    ],
  });
  const final = await waitTerminal(job.id);
  assert.equal(final.successCount, 1);
  assert.equal(final.skipCount, 1);
  const skipped = final.targets.find((t) => t.phone === '994551234567');
  assert.equal(skipped.status, 'skipped');
});

test('cancelChatJobs cancels active jobs', async () => {
  wa.getSenderSocket = () => ({
    sock: {
      sendMessage: async () => { await sleep(200); return {}; },
      onWhatsApp: async () => [],
    },
    phone: '994501234567',
  });

  const job = broadcastService.createJob({
    chatId: 'chat9',
    type: 'text',
    payloadSpec: { type: 'text', text: 'x' },
    targets: [{ phone: '994501234567' }, { phone: '994551234567' }],
  });
  broadcastService.cancelChatJobs('chat9');
  const final = await waitTerminal(job.id);
  assert.equal(final.state, 'cancelled');
});

test('one transient error does not stop the job — all targets attempted', async () => {
  const sent = [];
  wa.getSenderSocket = () => ({
    sock: {
      ws: { isOpen: true }, // socket açıqdır — "Connection Closed" müvəqqəti xətadır
      sendMessage: async (jid) => {
        sent.push(jid);
        if (jid === '994551234567@s.whatsapp.net') throw new Error('Connection Closed'); // müvəqqəti blip
        return {};
      },
      onWhatsApp: async (...ps) => ps.map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: true })),
    },
    phone: '994501234567',
  });

  const job = broadcastService.createJob({
    chatId: 'chat-tx',
    type: 'text',
    payloadSpec: { type: 'text', text: 'salam' },
    targets: [
      { phone: '994501234567' },
      { phone: '994551234567' },
      { phone: '994701234567' },
    ],
  });
  const final = await waitTerminal(job.id);
  assert.equal(final.state, 'completed'); // interrupted DEYİL — loop dayanmadı
  assert.equal(final.successCount, 2);
  assert.equal(final.failCount, 1);
  // Bütün nömrələrə cəhd olundu: 1 + (2-ci: 2 cəhd) + 1 = 4
  assert.equal(sent.length, 4);
  assert.ok(sent.includes('994701234567@s.whatsapp.net'));
});

test('retryFailed creates a new job from failed targets', async () => {
  const old = jobStore.create({
    chatId: 'chat7',
    type: 'text',
    payloadSpec: { type: 'text', text: 'salam' },
    targets: [
      { phone: '994501234567', name: 'A' },
      { phone: '994551234567', name: 'B' },
    ],
  });
  jobStore.updateTarget(old, '994551234567', { status: 'failed', error: 'boom' });

  wa.getSenderSocket = () => ({
    sock: {
      sendMessage: async () => ({}),
      onWhatsApp: async (...ps) => ps.map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: true })),
    },
    phone: '994501234567',
  });

  const newJob = broadcastService.retryFailed(old.id);
  assert.ok(newJob);
  assert.equal(newJob.targets.length, 1);
  assert.equal(newJob.targets[0].phone, '994551234567');
  const final = await waitTerminal(newJob.id);
  assert.equal(final.state, 'completed');
  assert.equal(final.successCount, 1);
});

test('2 numbers — transient error after the first send does not skip the second (user report)', async () => {
  const sent = [];
  const failOnce = new Set(['994514143432@s.whatsapp.net']);
  wa.getSenderSocket = () => ({
    sock: {
      ws: { isOpen: true }, // socket açıqdır — xəta müvəqqətidir
      sendMessage: async (jid) => {
        sent.push(jid);
        if (failOnce.has(jid)) {
          failOnce.delete(jid); // ilk cəhddə müvəqqəti "Connection Closed", retry-da uğur
          throw new Error('Connection Closed');
        }
        return {};
      },
      onWhatsApp: async (...ps) => ps.map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: true })),
    },
    phone: '994501234567',
  });

  const job = broadcastService.createJob({
    chatId: 'chat-exact',
    type: 'text',
    payloadSpec: { type: 'text', text: 'test mesajı' },
    targets: [
      { phone: '994503482690' },
      { phone: '994514143432' },
    ],
  });
  const final = await waitTerminal(job.id);
  assert.equal(final.state, 'completed');
  // Hər iki nömrəyə ayrıca cəhd olunub: 1-ci 1 cəhd, 2-ci müvəqqəti xətada 2 cəhd (retry)
  assert.equal(sent.length, 3);
  assert.ok(sent.includes('994503482690@s.whatsapp.net'));
  assert.ok(sent.includes('994514143432@s.whatsapp.net'));
  assert.equal(final.successCount, 2);
  assert.equal(final.failCount, 0);
});
