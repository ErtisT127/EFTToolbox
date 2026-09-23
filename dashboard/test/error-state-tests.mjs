import test from 'node:test';
import assert from 'node:assert/strict';
import { DataLoadError, isDataLoadError, shouldPushNotice } from '../src/lib/errors.ts';

test('data errors use explicit classification instead of message matching', () => {
  const dataError = new DataLoadError('errors.map_data_invalid', 'map');
  assert.equal(isDataLoadError(dataError), true);
  assert.equal(isDataLoadError(new Error('errors.map_data_invalid')), false);
});

test('notice deduplication allows changed keys and three-second retries', () => {
  assert.equal(shouldPushNotice(null, 'errors.request_failed', 1000, 3000), true);
  assert.equal(
    shouldPushNotice(
      { key: 'errors.request_failed', at: 1000 },
      'errors.request_failed',
      3999,
      3000,
    ),
    false,
  );
  assert.equal(
    shouldPushNotice(
      { key: 'errors.request_failed', at: 1000 },
      'errors.request_failed',
      4000,
      3000,
    ),
    true,
  );
  assert.equal(
    shouldPushNotice(
      { key: 'errors.request_failed', at: 1000 },
      'errors.map_data_invalid',
      1001,
      3000,
    ),
    true,
  );
});
