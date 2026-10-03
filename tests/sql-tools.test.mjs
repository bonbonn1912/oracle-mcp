import assert from 'node:assert/strict';
import test from 'node:test';
import { sqlTools } from '../dist/tools/sql.js';

const tools = new Map(sqlTools.map((tool) => [tool.name, tool]));
const unboundedUpdate =
  'UPDATE accounts SET status = (SELECT status FROM defaults WHERE id = 1)';

function context(readOnly = false) {
  const calls = [];
  return {
    calls,
    config: { maxRows: 200, readOnly },
    db: {
      async exec(...args) {
        calls.push(args);
        return { rowsAffected: 10 };
      },
      async table(...args) {
        calls.push(args);
        return { columns: ['ID'], rows: [[1]], rowCount: 1, truncated: false };
      },
    },
  };
}

test('execute previews an unbounded update with a nested WHERE without touching the DB', async () => {
  const ctx = context();
  const result = await tools.get('oracle_execute').handler({ sql: unboundedUpdate }, ctx);
  assert.equal(result.executed, false);
  assert.equal(result.preview, true);
  assert.deepEqual(result.statements, [unboundedUpdate]);
  assert.deepEqual(ctx.calls, []);
});

test('explicit confirmation executes an unbounded update', async () => {
  const ctx = context();
  const result = await tools.get('oracle_execute').handler({ sql: unboundedUpdate, confirm: true }, ctx);
  assert.equal(result.executed, true);
  assert.equal(result.rowsAffected, 10);
  assert.deepEqual(ctx.calls, [[unboundedUpdate, {}, true]]);
});

test('an outer WHERE allows a bounded update without confirmation', async () => {
  const ctx = context();
  const sql = `${unboundedUpdate} WHERE account_id = 7`;
  const result = await tools.get('oracle_execute').handler({ sql, autocommit: false }, ctx);
  assert.equal(result.executed, true);
  assert.deepEqual(ctx.calls, [[sql, {}, false]]);
});

test('script preflight blocks all statements when a later unbounded update needs confirmation', async () => {
  const ctx = context();
  const script = `INSERT INTO log_messages VALUES ('start');\n${unboundedUpdate};`;
  const result = await tools.get('oracle_run_script').handler({ script }, ctx);
  assert.equal(result.preview, true);
  assert.equal(result.statementCount, 2);
  assert.equal(result.destructive[0].index, 2);
  assert.deepEqual(ctx.calls, []);
});

test('query rejects row locking before database access in read-only mode', async () => {
  const ctx = context(true);
  await assert.rejects(
    tools.get('oracle_query').handler({ sql: 'SELECT id FROM accounts FOR UPDATE' }, ctx),
    /FOR UPDATE.*read-only/i,
  );
  assert.deepEqual(ctx.calls, []);
});

test('a literal containing FOR UPDATE is still a valid read-only query', async () => {
  const ctx = context(true);
  const result = await tools.get('oracle_query').handler({ sql: "SELECT 'FOR UPDATE' FROM dual" }, ctx);
  assert.equal(result.rowCount, 1);
  assert.equal(ctx.calls.length, 1);
});
