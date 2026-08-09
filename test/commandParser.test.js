const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, isNumbersOnly, isSinglePhoneNumber } = require('../modules/commandParser');

test('parseCommand recognizes .rr/.ss/.gg/.cc and aliases', () => {
  assert.deepEqual(parseCommand('.rr'), { type: 'rr', arg: '' });
  assert.deepEqual(parseCommand('.ss c'), { type: 'ss', arg: 'c' });
  assert.deepEqual(parseCommand('.gg 994501234567'), { type: 'gg', arg: '994501234567' });
  assert.equal(parseCommand('.cc').type, 'cc');
  assert.equal(parseCommand('hello'), null);
});

test('isNumbersOnly handles separators and multi-line', () => {
  assert.equal(isNumbersOnly('0501234567\n055-123-45-67\n+994 70 123 45 67'), true);
  assert.equal(isNumbersOnly('0501234567\nsalam'), false);
  assert.equal(isNumbersOnly(''), false);
});

test('isSinglePhoneNumber', () => {
  assert.equal(isSinglePhoneNumber('994501234567'), true);
  assert.equal(isSinglePhoneNumber('+994 50 123 45 67'), true);
  assert.equal(isSinglePhoneNumber('0501234567\n0551234567'), false);
  assert.equal(isSinglePhoneNumber('salam'), false);
});
