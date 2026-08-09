const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPayload, specFromBuilt } = require('../lib/telegramPayload');

test('buildPayload — text', async () => {
  const built = await buildPayload({ text: 'salam dünya' }, null);
  assert.equal(built.type, 'text');
  assert.deepEqual(built.payload, { text: 'salam dünya' });
});

test('buildPayload — unsupported', async () => {
  const built = await buildPayload({ poll: {} }, null);
  assert.equal(built.type, 'unsupported');
  assert.equal(built.payload, null);
});

test('specFromBuilt roundtrip for text/location/contact', () => {
  const text = specFromBuilt({ type: 'text', payload: { text: 'hi' } });
  assert.deepEqual(text, { type: 'text', text: 'hi' });

  const loc = specFromBuilt({
    type: 'location',
    payload: { location: { degreesLatitude: 40.4, degreesLongitude: 49.8 } },
  });
  assert.equal(loc.latitude, 40.4);

  const contact = specFromBuilt({
    type: 'contact',
    payload: { contacts: { displayName: 'A' } },
  });
  assert.equal(contact.contact.displayName, 'A');
});
