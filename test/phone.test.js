const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, isValidAzerbaijanMobile, parseContacts, parseNumbers, validateName, cleanName, formatPhone } = require('../lib/phone');
const az = require('../lib/azPhone');

test('normalizePhone — all supported Azerbaijani formats', () => {
  const cases = [
    '+994501234567', '994501234567', '0501234567', '0551234567',
    '0701234567', '0771234567', '0991234567', '0101234567',
    '0511234567', '050 123 45 67', '055-123-45-67',
    '+994 50 123 45 67', '501234567', '(050) 123-45-67', '050.123.45.67',
  ];
  for (const c of cases) {
    assert.equal(normalizePhone(c), '994' + (c.replace(/\D/g, '').length === 9 ? c.replace(/\D/g, '') : c.replace(/\D/g, '').slice(-9)), `failed for ${c}`);
  }
  assert.equal(normalizePhone('0501234567'), '994501234567');
  assert.equal(normalizePhone('055-123-45-67'), '994551234567');
  assert.equal(normalizePhone('0101234567'), '994101234567');
  assert.equal(normalizePhone('0601234567'), '994601234567'); // AzInTelecom
});

test('normalizePhone — invalid inputs return null', () => {
  for (const bad of ['', 'abc', '0123456789', '994123456789', '055123456', '+9945512345678', '9940501234567', '123456789', null, undefined, '050 123 45']) {
    assert.equal(normalizePhone(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('isValidAzerbaijanMobile', () => {
  assert.equal(isValidAzerbaijanMobile('994501234567'), true);
  assert.equal(isValidAzerbaijanMobile('0501234567'), true);
  assert.equal(isValidAzerbaijanMobile('994121234567'), false);
  assert.equal(isValidAzerbaijanMobile('0121234567'), false);
});

test('formatPhone displays +994 XX XXX XX XX', () => {
  assert.equal(formatPhone('994501234567'), '+994 50 123 45 67');
  assert.equal(az.formatPhone('994773648648'), '+994 77 364 86 48');
});

test('validateName — empty and Azerbaijani letters', () => {
  assert.equal(validateName('').ok, false);
  assert.equal(validateName('   ').ok, false);
  assert.equal(validateName('Ələsgər Məmmədov').ok, true);
  assert.equal(validateName('Şəmsi Rəhimova').name, 'Şəmsi Rəhimova');
  assert.equal(validateName('Ömər Ülvi Çətələkov').ok, true);
  assert.equal(cleanName('  Akif   Babayev '), 'Akif Babayev');
});

test('parseContacts — name/number pairs (Azerbaijani names)', () => {
  const { contacts, errors } = parseContacts(
    'Quliyev Cəmil Bayram\n0503767264\n\nAkif Babayev\n077 364 86 48\n\nƏli Məmmədov 055-123-45-67'
  );
  assert.equal(errors.length, 0);
  assert.deepEqual(contacts, [
    { name: 'Quliyev Cəmil Bayram', phone: '994503767264' },
    { name: 'Akif Babayev', phone: '994773648648' },
    { name: 'Əli Məmmədov', phone: '994551234567' },
  ]);
});

test('parseContacts — errors are reported per line', () => {
  const { contacts, errors } = parseContacts('994501234567\n\nYanlış nömrə\n0123456789\n\nTəksətir\n');
  assert.equal(contacts.length, 0);
  assert.equal(errors.length, 3);
  assert.match(errors[0].reason, /Ad yoxdur/);
  assert.match(errors[1].reason, /Yanlış telefon nömrəsi/);
  assert.match(errors[2].reason, /Nömrə tapılmadı/);
});

test('parseContacts — duplicate phones deduplicated', () => {
  const { contacts } = parseContacts('A\n0501234567\n\nB\n050 123 45 67\n\nC\n+994501234567');
  assert.equal(contacts.length, 1);
});

test('parseNumbers — mixed formats normalized and deduped by caller', () => {
  const { numbers, errors } = parseNumbers('0501234567\n+994551234567\n994 70 123 45 67\n0123456789\n');
  assert.deepEqual(numbers, ['994501234567', '994551234567', '994701234567']);
  assert.equal(errors.length, 1);
});
