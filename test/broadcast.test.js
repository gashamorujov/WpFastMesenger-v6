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

test('broadcast — real connection loss (socket closed) interrupts the loop', async () => {
  const sock = makeSock({ connectionLost: new Set([jidForPhone('994551234567')]) });
  sock.ws = { isOpen: false }; // WebSocket həqiqətən qapalı
  const report = await broadcast(sock, targets(['994501234567', '994551234567', '994701234567']), { text: 'hi' }, { delayMinMs: 2, delayMaxMs: 2 });
  assert.equal(report.interrupted, true);
  assert.equal(report.fail, 1);
  assert.equal(report.failed[0].phone, '994551234567');
  assert.equal(sock.calls.length, 2); // 3-cü nömrəyə cəhd edilmir (socket ölüdür)
});

test('broadcast — transient "Connection Closed" while socket is open does NOT stop the loop', async () => {
  const sock = makeSock({ connectionLost: new Set([jidForPhone('994551234567')]) });
  sock.ws = { isOpen: true }; // müvəqqəti xəta — socket açıqdır
  const report = await broadcast(sock, targets(['994501234567', '994551234567', '994701234567']), { text: 'hi' }, {
    delayMinMs: 2,
    delayMaxMs: 2,
    maxRetries: 1,
  });
  assert.equal(report.interrupted, false);
  assert.equal(report.success, 2); // 1-ci və 3-cü göndərildi
  assert.equal(report.fail, 1); // 2-ci uğursuz, amma loop dayanmadı
  // Bütün nömrələrə cəhd olundu: 1 + (2-ci: 2 cəhd) + 1 = 4
  assert.equal(sock.calls.length, 4);
  assert.ok(sock.calls.some((c) => c.jid === jidForPhone('994701234567')));
});

test('broadcast — server error receipt (status ERROR) counts as failed, others continue', async () => {
  const handlers = {};
  const sock = makeSock();
  sock.ev = { on: (ev, cb) => { handlers[ev] = cb; }, off: () => {} };
  const origSend = sock.sendMessage;
  let callNo = 0;
  sock.sendMessage = async (jid) => {
    callNo++;
    const msgId = `err-${jid}`;
    if (callNo === 2) {
      // server bu mesajı rədd edir (nömrə qeydiyyatda deyil)
      setTimeout(() => handlers['messages.update']?.([{ key: { id: msgId }, status: 0 }]), 2);
    }
    return { key: { id: msgId } };
  };
  const report = await broadcast(sock, targets(['994501234567', '994551234567', '994701234567']), { text: 'hi' }, {
    ackTracking: true,
    ackTimeoutMs: 300,
    delayMinMs: 2,
    delayMaxMs: 2,
  });
  assert.equal(report.interrupted, false);
  assert.equal(report.success, 2);
  assert.equal(report.fail, 1);
  assert.equal(report.failed[0].phone, '994551234567');
  sock.sendMessage = origSend;
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

test('broadcast — 100 targets, no artificial limit, all sent sequentially', async () => {
  const sock = makeSock();
  const phones = Array.from({ length: 100 }, (_, i) => `99450${String(1000000 + i).slice(1)}`);
  const report = await broadcast(sock, targets(phones), { text: 'hi' }, { delayMinMs: 0, delayMaxMs: 1 });
  assert.equal(report.success, 100);
  assert.equal(report.fail, 0);
  assert.equal(sock.calls.length, 100);
  assert.equal(sock.calls[0].jid, `99450${String(1000000).slice(1)}@s.whatsapp.net`);
  assert.equal(sock.calls[99].jid, `99450${String(1000099).slice(1)}@s.whatsapp.net`);
});

test('broadcast — 3-line user input style sends each line separately', async () => {
  const sock = makeSock();
  const report = await broadcast(sock, targets(['994503482690', '994773971757', '994514143432']), { text: 'Salam' }, { delayMinMs: 1, delayMaxMs: 1 });
  assert.equal(report.success, 3);
  assert.deepEqual(sock.calls.map((c) => c.jid), [
    '994503482690@s.whatsapp.net',
    '994773971757@s.whatsapp.net',
    '994514143432@s.whatsapp.net',
  ]);
});

test('broadcast — unknown socket state: 3 consecutive connection errors interrupt (resume-safe)', async () => {
  const sock = makeSock({
    connectionLost: new Set([jidForPhone('994551234567'), jidForPhone('994701234567'), jidForPhone('994771234567')]),
  });
  // ws mövcud deyil → vəziyyət 'unknown'; ardıcıl bağlantı xətası limiti işə düşür
  const report = await broadcast(
    sock,
    targets(['994501234567', '994551234567', '994701234567', '994771234567', '994781234567']),
    { text: 'hi' },
    { delayMinMs: 1, delayMaxMs: 1, maxRetries: 0 }
  );
  assert.equal(report.interrupted, true);
  assert.equal(report.success, 1);
  assert.equal(report.fail, 3);
  // 5-ci nömrəyə cəhd edilmir — 3 ardıcıl bağlantı xətası loop-u dayandırdı
  assert.equal(sock.calls.length, 4);
  assert.equal(report.failed.length, 3);
});
