const { isolateDataDir } = require('./helpers');
isolateDataDir('jobstore');
const test = require('node:test');
const assert = require('node:assert/strict');
const jobStore = require('../modules/jobStore');

test.before(() => jobStore._reset());
test.after(() => jobStore._reset());

function sampleJob() {
  return jobStore.create({
    chatId: '123',
    type: 'text',
    payloadSpec: { type: 'text', text: 'salam' },
    targets: [
      { phone: '994501234567', name: 'A' },
      { phone: '994551234567', name: 'B' },
      { phone: '994701234567', name: 'C' },
    ],
  });
}

test('create + read + updateTarget counters', () => {
  const job = sampleJob();
  assert.equal(job.state, 'running');
  assert.equal(job.targets.length, 3);

  jobStore.updateTarget(job, '994501234567', { status: 'sent' });
  jobStore.updateTarget(job, '994551234567', { status: 'failed', error: 'x' });

  const fresh = jobStore.read(job.id);
  assert.equal(fresh.successCount, 1);
  assert.equal(fresh.failCount, 1);
  assert.equal(fresh.targets.find((t) => t.phone === '994551234567').error, 'x');

  // sent → failed recount
  jobStore.updateTarget(fresh, '994501234567', { status: 'failed', error: 'y' });
  const fresh2 = jobStore.read(job.id);
  assert.equal(fresh2.successCount, 0);
  assert.equal(fresh2.failCount, 2);
});

test('markCompleted / markCancelled / recoverInterrupted', () => {
  jobStore._reset();
  const j1 = sampleJob();
  jobStore.markCompleted(j1, { success: 2, fail: 1, skip: 0 });
  assert.equal(jobStore.read(j1.id).state, 'completed');

  const j2 = sampleJob(); // stays 'running' as if process died
  const recovered = jobStore.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(jobStore.read(j2.id).state, 'interrupted');

  jobStore.markCancelled(jobStore.read(j2.id));
  assert.equal(jobStore.read(j2.id).state, 'cancelled');
  assert.equal(jobStore.listActive().length, 0);
});

test('deleteJob removes files', () => {
  const j = sampleJob();
  jobStore.deleteJob(j);
  assert.equal(jobStore.read(j.id), null);
});
