const { isolateDataDir } = require('./helpers');
isolateDataDir('recentsends');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DUPLICATE_SEND_TTL_MIN = '1'; // short TTL for tests
const recentSends = require('../modules/recentSends');

test.before(() => recentSends._reset());
test.after(() => recentSends._reset());

test('markSent + isDuplicate keyed by payload + normalization', () => {
  recentSends.markSent('0501234567', 'key-a');
  // same payload → duplicate
  assert.equal(recentSends.isDuplicate('994501234567', 'key-a'), true);
  // different payload → allowed
  assert.equal(recentSends.isDuplicate('+994501234567', 'key-b'), false);
  // unknown phone → allowed
  assert.equal(recentSends.isDuplicate('994551234567', 'key-a'), false);
  assert.ok(recentSends.recentPhones().includes('994501234567'));
  assert.equal(recentSends.isRecent('994501234567'), true);
});

test('isDuplicate returns false for a different number', () => {
  recentSends.markSent('994551234567', 'key-a');
  assert.equal(recentSends.isDuplicate('994551234567', 'key-b'), false);
});
