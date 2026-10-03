import assert from "node:assert/strict";
import test from "node:test";
import { Db } from "../dist/db.js";

const config = {
  name: "mock",
  description: "",
  user: "test",
  password: "",
  passwordVar: "",
  connectString: "unused",
  privilege: "",
  readOnly: false,
  maxRows: 100,
  callTimeoutMs: 0,
  exportDir: ".",
  dictionary: "all",
};

function mockDb(totalRows) {
  const db = new Db(config);
  const rows = Array.from({ length: totalRows }, (_, i) => [i + 1]);
  db.connection = async () => ({
    isHealthy: () => true,
    execute: async (_sql, _binds, options) => ({
      metaData: [{ name: "ID" }],
      rows: rows.slice(0, options.maxRows),
    }),
  });
  return db;
}

test("rows rejects an incomplete lookup above its cap", async () => {
  const db = mockDb(5001);
  await assert.rejects(db.rows("SELECT id FROM items"), (err) => {
    assert.equal(err.name, "ToolError");
    assert.match(err.message, /more than 5000 rows.*truncated/i);
    assert.equal(err.details.rowLimit, 5000);
    assert.match(err.details.sql, /SELECT id FROM items/);
    return true;
  });
});

test("rows accepts a complete result at the cap", async () => {
  const result = await mockDb(5000).rows("SELECT id FROM items");
  assert.equal(result.length, 5000);
  assert.deepEqual(result[0], { id: 1 });
  assert.deepEqual(result.at(-1), { id: 5000 });
});

test("list keeps its display truncation behavior", async () => {
  const result = await mockDb(6).list("SELECT id FROM items", {}, 5);
  assert.deepEqual(result.rows, [1, 2, 3, 4, 5].map((id) => ({ id })));
  assert.equal(result.rowCount, 5);
  assert.equal(result.truncated, true);
});
