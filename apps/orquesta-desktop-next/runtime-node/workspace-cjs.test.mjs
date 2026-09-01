import assert from 'node:assert/strict';
import test from 'node:test';

import eventStore from '../../../packages/event-store/src/index.js';

test('runtime-node event-store boundary exposes only the current business event store', () => {
  assert.equal(typeof eventStore.createEventStore, 'function');
  assert.deepEqual(Object.keys(eventStore).sort(), [
    'CRASH_POINTS',
    'acquireJournalLock',
    'createEventStore',
    'inspectJournalLock',
    'releaseJournalLock',
  ]);
});
