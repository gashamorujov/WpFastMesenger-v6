const { isolateDataDir } = require('./helpers');
isolateDataDir('contactservice');
const test = require('node:test');
const assert = require('node:assert/strict');

const wa = require('../modules/whatsappManager');
const waPresence = require('../modules/waPresence');
const contactStore = require('../modules/contactStore');
const { addContact, syncAllToWhatsApp } = require('../modules/contactService');

test.before(() => {
  contactStore._reset();
  waPresence._resetCache();
});

test('addContact — connected socket: stored + mirrored to WhatsApp (added)', async () => {
  let synced = null;
  wa.getSenderSocket = () => ({
    sock: {
      onWhatsApp: async (p) => [{ jid: `${p}@s.whatsapp.net`, exists: true }],
      addOrEditContact: async (jid, action) => { synced = { jid, action }; return { status: 200 }; },
    },
    phone: '994501234567',
  });

  const res = await addContact({ name: 'Akif Babayev', phone: '077 364 86 48' });
  assert.equal(res.status, 'added');
  assert.equal(res.waRegistered, true);
  assert.equal(synced.jid, '994773648648@s.whatsapp.net');
  assert.equal(synced.action.fullName, 'Akif Babayev');
  assert.equal(synced.action.saveOnPrimaryAddressbook, false); // WhatsApp-only, not phone book
  assert.equal(contactStore.count(), 1);
});

test('addContact — existing phone + same name → duplicate, no new contact', async () => {
  const res = await addContact({ name: 'Akif Babayev', phone: '994773648648' });
  assert.equal(res.status, 'duplicate');
  assert.equal(contactStore.count(), 1);
});

test('addContact — existing phone + new name → updated in place', async () => {
  const res = await addContact({ name: 'Akif B.', phone: '+994 77 364 86 48' });
  assert.equal(res.status, 'updated');
  assert.equal(contactStore.count(), 1);
  assert.equal(contactStore.get('994773648648').name, 'Akif B.');
});

test('addContact — no WhatsApp socket → stored locally only', async () => {
  wa.getSenderSocket = () => null;
  const res = await addContact({ name: 'Zəhra Quliyeva', phone: '0501234567' });
  assert.equal(res.status, 'stored');
  assert.equal(contactStore.get('994501234567').name, 'Zəhra Quliyeva');
});

test('addContact — WhatsApp sync error → stored locally, not failed', async () => {
  wa.getSenderSocket = () => ({
    sock: {
      onWhatsApp: async () => [{ jid: '994555555555@s.whatsapp.net', exists: true }],
      addOrEditContact: async () => { throw new Error('app state key not present'); },
    },
    phone: '994501234567',
  });
  const res = await addContact({ name: 'X', phone: '0555555555' });
  assert.equal(res.status, 'stored');
  assert.ok(res.reason);
  assert.equal(contactStore.get('994555555555').name, 'X');
});

test('addContact — invalid data → failed', async () => {
  wa.getSenderSocket = () => null;
  const res = await addContact({ name: '', phone: '994501234567' });
  assert.equal(res.status, 'failed');
});

test('syncAllToWhatsApp — database-dəki bütün kontaktlar WhatsApp-a əlavə olunur', async () => {
  const synced = [];
  wa.getSenderSocket = () => ({
    sock: {
      addOrEditContact: async (jid, action) => { synced.push({ jid, action }); return { status: 200 }; },
    },
    phone: '994501234567',
  });

  const before = contactStore.count();
  const res = await syncAllToWhatsApp();
  assert.equal(res.ok, true);
  assert.equal(res.total, before);
  assert.equal(res.okCount, before);
  assert.deepEqual(res.failed, []);
  assert.ok(synced.some((s) => s.jid === '994773648648@s.whatsapp.net'));
  assert.ok(synced.some((s) => s.jid === '994501234567@s.whatsapp.net'));
  assert.ok(synced.every((s) => s.action.fullName));
});

test('syncAllToWhatsApp — WhatsApp socket yoxdur → ok:false + reason', async () => {
  wa.getSenderSocket = () => null;
  const res = await syncAllToWhatsApp();
  assert.equal(res.ok, false);
  assert.ok(res.reason);
  assert.equal(res.okCount, 0);
});
