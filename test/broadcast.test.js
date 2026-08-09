const test = require('node:test');
const assert = require('node:assert/strict');
const { broadcast, jidForPhone } = require('../lib/broadcast');
const { sleep } = require('../lib/myfunc');

function makeSock(opts = {}) {
  const calls = [];
  const sock = {
    calls,
    failures: new Set(opts.failures || []),       // jids that always fail
    failOnce: new Set(opts.failOnce || []),       // jids that fail on first attempt
    connectionLost: new Set(opts.connectionLost || []),
    sendMessage: async (jid, payload) => {
      calls.push({ jid, payload });
      await sleep(2);
      if (sock.failures.has(jid)) throw new Error('server error 500');
      if (sock.failOnce.has(jid)) {
        sock.failOnce.delete(jid);
        throw new Error('server error 500');
      }
      if (sock.connectionLost.has(jid)) throw new Error('Connection Closed');
      return { key: { id: 'x' } };
    },
  };
  if (opts.onWhatsApp) {
    sock.onWhatsApp = async (...phones) =>
      phones.map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: opts.onWhatsApp.has(p) }));
  }
  return sock;
}

const targets = (phones) => phones.map((p) => ({ jid: jidForPhone(p), label: p, phone: p }));

test('broadcast — sends to all targets sequentially', async () => {
  const sock = makeSock();
  const report = await broadcast(sock, targets(['994501234567', '994551234567']), { text: 'hi' }, { delayMinMs: 2, delayMaxMs: 2 });
  assert.equal(report.success, 2);
  assert.equal(report.fail, 0);
  assert.equal(sock.calls.length, 2);
});

test('broadcast — one failure does not stop the rest', async () => {
  const sock = makeSock({ failures: new Set([jidForPhone('994501234567')]) });
  const report = await broadcast(sock, targets(['994501234567', '994551234567', '994701234567']), { text: 'hi' }, { delayMinMs: 2, delayMaxMs: 2, maxRetries: 1 });
  assert.equal(report.success, 2);
  assert.equal(report.fail, 1);
  assert.equal(report.failed[0].phone, '994501234567');
});

test('broadcast — retries a transient failure', async () => {
  const sock = makeSock({ failOnce: new Set([jidForPhone('994501234567')]) });
  const report = await broadcast(sock, targets(['994501234567']), { text: 'hi' }, { maxRetries: 2, delayMinMs: 2, delayMaxMs: 2 });
  assert.equal(report.success, 1);
  assert.equal(report.fail, 0);
});

test('broadcast — skips numbers not registered on WhatsApp', async () => {
  const sock = makeSock({ onWhatsApp: new Set(['994501234567']) });
  const report = await broadcast(
    sock,
    targets(['994501234567', '994551234567']),
    { text: 'hi' },
    { checkRegistered: true, skipUnregistered: true, delayMinMs: 2, delayMaxMs: 2 }
  );
  assert.equal(report.success, 1);
  assert.equal(report.skip, 1);
  assert.equal(report.skipped[0].reason, 'WhatsApp-da qeydiyyatda deyil');
  assert.equal(sock.calls.length, 1); // never attempted for the unregistered one
});

test('broadcast — duplicate guard skips same-payload recent sends', async () => {
  const sock = makeSock();
  const recent = new Set(['994551234567']);
  const report = await broadcast(sock, targets(['994501234567', '994551234567']), { text: 'hi' }, {
    duplicateGuard: { isDuplicate: (p) => recent.has(p), markSent: (p) => recent.add(p) },
    delayMinMs: 2,
    delayMaxMs: 2,
  });
  assert.equal(report.success, 1);
  assert.equal(report.skip, 1);
  assert.match(report.skipped[0].reason, /artıq göndərilib/);
});

test('broadcast — cancellation stops between items', async () => {
  const sock = makeSock();
  let cancelled = false;
  const report = await broadcast(sock, targets(['994501234567', '994551234567', '994701234567']), { text: 'hi' }, {
    isCancelled: () => cancelled,
    onProgress: (u) => { if (u.done === 1) cancelled = true; },
    delayMinMs: 2,
    delayMaxMs: 2,
  });
  assert.equal(report.interrupted, true);
  assert.equal(report.success, 1);
});

test('broadcast — connection loss interrupts the loop', async () => {
  const sock = makeSock({ connectionLost: new Set([jidForPhone('994551234567')]) });
  const report = await broadcast(sock, targets(['994501234567', '994551234567', '994701234567']), { text: 'hi' }, { delayMinMs: 2, delayMaxMs: 2 });
  assert.equal(report.interrupted, true);
  assert.equal(report.fail, 1);
  assert.equal(report.failed[0].phone, '994551234567');
});

test('broadcast — progress callbacks report per-target status', async () => {
  const sock = makeSock();
  const updates = [];
  await broadcast(sock, targets(['994501234567', '994551234567']), { text: 'hi' }, {
    delayMinMs: 2,
    delayMaxMs: 2,
    onProgress: (u) => updates.push(u.status),
  });
  assert.deepEqual(updates, ['sent', 'sent']);
});

test('broadcast — ackTracking counts server-delivered messages', async () => {
  const handlers = {};
  const sock = makeSock();
  sock.ev = {
    on: (ev, cb) => { handlers[ev] = cb; },
    off: () => {},
  };
  const origSend = sock.sendMessage;
  sock.sendMessage = async (jid, payload) => {
    const msgId = `ack-${jid}`;
    setTimeout(() => {
      if (handlers['messages.update']) handlers['messages.update']([{ key: { id: msgId }, status: 3 }]);
    }, 5);
    return { key: { id: msgId } };
  };

  const report = await broadcast(sock, targets(['994501234567', '994551234567']), { text: 'hi' }, {
    ackTracking: true,
    ackTimeoutMs: 500,
    delayMinMs: 2,
    delayMaxMs: 2,
  });
  assert.equal(report.success, 2);
  assert.equal(report.delivered, 2);
  sock.sendMessage = origSend;
});

test('broadcast — ackTimeout leaves delivered at 0 but success counts', async () => {
  const sock = makeSock();
  sock.ev = { on: () => {}, off: () => {} };
  const report = await broadcast(sock, targets(['994501234567']), { text: 'hi' }, {
    ackTracking: true,
    ackTimeoutMs: 20,
    delayMinMs: 2,
    delayMaxMs: 2,
  });
  assert.equal(report.success, 1);
  assert.equal(report.delivered, 0);
});
