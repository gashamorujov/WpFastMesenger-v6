const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager, STATES } = require('../modules/sessionManager');
const fs = require('fs-extra');
const path = require('path');

test('session states, contact flow and cleanup', async () => {
  const sm = new SessionManager();
  const s = sm.get('chat1');
  s.state = STATES.SS_NUMBERS;
  s.numbers.push({ phone: '994501234567', name: 'A' });
  s.ctPhone = '994501234567';
  s.botMsgs.push(11, 22);

  const tmp = path.join(__dirname, 'tmp-test-session.txt');
  fs.writeFileSync(tmp, 'x');
  s.tempFiles.push(tmp);

  assert.equal(sm.cancel('chat1'), true);
  assert.equal(s.numbers.length, 0);
  assert.equal(s.ctPhone, null);
  assert.equal(s.state, STATES.IDLE);
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(sm.cancel('missing-chat'), false);

  // Tracked bot message ids survive cancel; collectBotMsgs returns+clears them
  assert.deepEqual(s.botMsgs, [11, 22]);
  assert.deepEqual(sm.collectBotMsgs('chat1'), [11, 22]);
  assert.deepEqual(sm.collectBotMsgs('chat1'), []);
  assert.deepEqual(sm.collectBotMsgs('missing-chat'), []);
});

test('reset keeps session object but clears state', () => {
  const sm = new SessionManager();
  sm.get('c2').state = STATES.RR;
  sm.reset('c2');
  assert.equal(sm.get('c2').state, STATES.IDLE);
});
