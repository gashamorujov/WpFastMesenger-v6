const { isolateDataDir } = require('./helpers');
isolateDataDir('rrflow');
const test = require('node:test');
const assert = require('node:assert/strict');

const { sessionManager } = require('../modules/services');
const { STATES } = require('../modules/sessionManager');
const contactStore = require('../modules/contactStore');
const wa = require('../modules/whatsappManager');
const waPresence = require('../modules/waPresence');
const rr = require('../commands/rr');
const { sleep } = require('../lib/myfunc');

test.before(() => {
  contactStore._reset();
  waPresence._resetCache();
  wa.getSenderSocket = () => ({
    sock: {
      onWhatsApp: async (p) => [{ jid: `${p}@s.whatsapp.net`, exists: true }],
      addOrEditContact: async () => ({ status: 200 }),
    },
    phone: '994501234567',
  });
});

test.after(() => {
  sessionManager.destroy('rrchat');
});

test('full .rr flow: parse → queue → WhatsApp sync → report', async () => {
  const sent = [];
  const send = async (text, opts) => { sent.push({ text, opts }); return { message_id: sent.length }; };

  await rr.start('rrchat', send);
  assert.equal(sessionManager.get('rrchat').state, STATES.RR);

  await rr.handle('rrchat', 'Akif Babayev\n077 364 86 48\n\nƏli Məmmədov\n+994551234567', send);

  // Wait for the queue to drain and the auto-clean to happen
  for (let i = 0; i < 100; i++) {
    if (sessionManager.get('rrchat').state === STATES.IDLE && sent.some((s) => s.text.includes('Kontakt emalı tamamlandı'))) break;
    await sleep(50);
  }

  assert.ok(sent.some((s) => s.text.includes('Kontakt emalı tamamlandı')));
  assert.equal(contactStore.count(), 2);
  const report = sent.find((s) => s.text.includes('Kontakt emalı tamamlandı')).text;
  assert.match(report, /WhatsApp kontaktlarına əlavə edildi: 2/);

  // duplicate phone with different name → updated, count stays 2
  contactStore._reset();
  waPresence._resetCache();
  await rr.start('rrchat', send);
  await rr.handle('rrchat', 'Akif Babayev\n077 364 86 48', send);
  await rr.handle('rrchat', 'Akif B.\n+994 77 364 86 48', send);
  for (let i = 0; i < 100; i++) {
    if (sent.filter((s) => s.text && s.text.includes('Kontakt emalı tamamlandı')).length >= 2) break;
    await sleep(50);
  }
  assert.equal(contactStore.count(), 1);
  assert.equal(contactStore.get('994773648648').name, 'Akif B.');
  const report2 = sent.filter((s) => s.text.includes('Kontakt emalı tamamlandı')).pop().text;
  assert.match(report2, /Yeniləndi \(duplicate yaradılmadı\): 1/);
  assert.match(report2, /Daxili bazada ümumi kontakt: 1/);
});
