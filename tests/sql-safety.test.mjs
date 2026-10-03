import test from 'node:test';
import assert from 'node:assert/strict';
import { destructiveReason } from '../dist/util.js';

test('unbounded UPDATE and DELETE are destructive even when nested SQL contains WHERE', () => {
  assert.equal(
    destructiveReason('UPDATE accounts SET status = (SELECT status FROM defaults WHERE id = 1)'),
    'UPDATE without WHERE',
  );
  assert.equal(
    destructiveReason('DELETE FROM accounts WHERE id IN (SELECT account_id FROM archived WHERE ready = 1)'),
    null,
  );
  assert.equal(
    destructiveReason('DELETE FROM accounts WHERE EXISTS (SELECT 1 FROM archived WHERE archived.id = accounts.id)'),
    null,
  );
});

test('only a top-level WHERE makes UPDATE and DELETE bounded', () => {
  assert.equal(destructiveReason('UPDATE accounts SET status = 1 WHERE id = 2'), null);
  assert.equal(destructiveReason('DELETE FROM accounts WHERE id = 2'), null);
  assert.equal(
    destructiveReason('UPDATE accounts SET status = (SELECT status FROM defaults WHERE id = 1)'),
    'UPDATE without WHERE',
  );
  assert.equal(
    destructiveReason('DELETE FROM accounts WHERE EXISTS (SELECT 1 FROM archived) /* nested-only? */'),
    null,
  );
});

test('WHERE text in literals and comments does not affect destructive classification', () => {
  assert.equal(
    destructiveReason("UPDATE accounts SET note = 'WHERE id = 1' -- WHERE id = 2\n"),
    'UPDATE without WHERE',
  );
  assert.equal(
    destructiveReason('DELETE FROM accounts /* WHERE id = 1 */'),
    'DELETE without WHERE',
  );
  assert.equal(
    destructiveReason("UPDATE accounts SET note = 'ok' WHERE id = 1 -- WHERE nested\n"),
    null,
  );
});
