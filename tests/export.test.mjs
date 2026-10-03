import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { exportTools } from "../dist/tools/export.js";

const exportQuery = exportTools.find((tool) => tool.name === "oracle_export_query").handler;

async function withExportDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-export-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeDb({ batches, execute = async () => undefined }) {
  let index = 0;
  let closeCount = 0;
  const db = {
    async connection() {
      return {
        async execute(...args) {
          await execute(...args);
          return {
            metaData: [{ name: "ID" }, { name: "VALUE" }],
            resultSet: {
              async getRows() {
                return batches[index++] ?? [];
              },
              async close() {
                closeCount++;
              },
            },
          };
        },
      };
    },
  };
  return { db, get closeCount() { return closeCount; } };
}

const args = (format, filename) => ({ sql: "SELECT id, value FROM items", format, filename });
const config = (exportDir, readOnly = false) => ({ exportDir, readOnly });

async function withWriteStreamFactory(factory, fn) {
  const original = fs.createWriteStream;
  fs.createWriteStream = factory;
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    fs.createWriteStream = original;
    syncBuiltinESMExports();
  }
}

test("read-only mode rejects SELECT FOR UPDATE before directory and database side effects", async () => {
  await withExportDir(async (base) => {
    const exportDir = path.join(base, "not-created");
    let connectCount = 0;
    const db = { async connection() { connectCount++; throw new Error("must not connect"); } };

    await assert.rejects(
      exportQuery({ ...args("CSV", "locked"), sql: "SELECT * FROM items FOR UPDATE" }, { db, config: config(exportDir, true) }),
      /FOR UPDATE.*not allowed in read-only mode/i,
    );
    assert.equal(connectCount, 0);
    await assert.rejects(stat(exportDir), { code: "ENOENT" });
  });
});

test("CSV and JSON exports stream multiple result batches", async () => {
  await withExportDir(async (exportDir) => {
    const batches = [
      [[1, "a,b"], [2, "quote\"value"]],
      [[3, null]],
      [],
    ];
    const csvDb = fakeDb({ batches });
    const csv = await exportQuery(args("CSV", "rows.csv"), { db: csvDb.db, config: config(exportDir) });
    assert.equal(csv.rows, 3);
    assert.equal(await readFile(csv.file, "utf8"), 'ID,VALUE\n1,"a,b"\n2,"quote""value"\n3,\n');
    assert.equal(csvDb.closeCount, 1);

    const jsonDb = fakeDb({ batches });
    const json = await exportQuery(args("JSON", "rows.json"), { db: jsonDb.db, config: config(exportDir) });
    assert.equal(json.rows, 3);
    assert.deepEqual(JSON.parse(await readFile(json.file, "utf8")), [
      { ID: 1, VALUE: "a,b" },
      { ID: 2, VALUE: 'quote"value' },
      { ID: 3, VALUE: null },
    ]);
    assert.equal(jsonDb.closeCount, 1);
  });
});

test("publication failure rejects, closes the cursor, and removes the temporary export", async () => {
  await withExportDir(async (exportDir) => {
    const targetDirectory = path.join(exportDir, "already-a-directory.csv");
    await mkdir(targetDirectory);
    const fake = fakeDb({ batches: [[[1, "value"]], []] });

    await assert.rejects(
      exportQuery(args("CSV", "already-a-directory.csv"), { db: fake.db, config: config(exportDir) }),
      (error) => ["EISDIR", "EEXIST"].includes(error.code),
    );
    assert.equal(fake.closeCount, 1);
    assert.deepEqual(await readdir(exportDir), ["already-a-directory.csv"]);
  });
});

test("write stream errors during cursor fetch reject promptly and preserve the target", { timeout: 3000 }, async () => {
  await withExportDir(async (exportDir) => {
    const target = path.join(exportDir, "existing.csv");
    await writeFile(target, "previous export\n");
    let output;
    let signalFetchStarted;
    const fetchStarted = new Promise((resolve) => { signalFetchStarted = resolve; });
    let closeCount = 0;
    let breakCount = 0;
    let busy = false;
    let fetchSettled = false;
    let releaseFetch;
    const lifecycle = [];
    const db = {
      async connection() {
        return {
          async break() {
            breakCount++;
            lifecycle.push("break");
            releaseFetch();
          },
          async execute() {
            return {
              metaData: [{ name: "ID" }],
              resultSet: {
                async getRows() {
                  busy = true;
                  lifecycle.push("fetch-start");
                  signalFetchStarted();
                  setImmediate(() => output.destroy(new Error("simulated write failure")));
                  try {
                    return await new Promise((_resolve, reject) => { releaseFetch = () => reject(new Error("fetch interrupted")); });
                  } finally {
                    busy = false;
                    fetchSettled = true;
                    lifecycle.push("fetch-settled");
                  }
                },
                async close() {
                  assert.equal(busy, false, "result set must not close during getRows");
                  assert.equal(fetchSettled, true, "getRows must settle before close");
                  closeCount++;
                  lifecycle.push("close");
                },
              },
            };
          },
        };
      },
    };

    await withWriteStreamFactory(() => {
      output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      return output;
    }, async () => {
      const result = exportQuery(args("CSV", "existing.csv"), { db, config: config(exportDir) });
      await fetchStarted;
      await assert.rejects(result, /simulated write failure/);
    });

    assert.equal(closeCount, 1);
    assert.equal(breakCount, 1);
    assert.deepEqual(lifecycle, ["fetch-start", "break", "fetch-settled", "close"]);
    assert.equal(await readFile(target, "utf8"), "previous export\n");
    assert.deepEqual(await readdir(exportDir), ["existing.csv"]);
  });
});

test("final flush errors reject instead of reporting export success", { timeout: 3000 }, async () => {
  await withExportDir(async (exportDir) => {
    const target = path.join(exportDir, "existing.json");
    await writeFile(target, "previous export\n");
    let closeCount = 0;
    const fake = fakeDb({ batches: [[]] });
    const db = {
      async connection() {
        const conn = await fake.db.connection();
        return {
          async execute(...args) {
            const result = await conn.execute(...args);
            const close = result.resultSet.close;
            result.resultSet.close = async () => { closeCount++; await close(); };
            return result;
          },
        };
      },
    };

    await withWriteStreamFactory(() => new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) { callback(new Error("simulated final flush failure")); },
    }), async () => {
      await assert.rejects(
        exportQuery(args("JSON", "existing.json"), { db, config: config(exportDir) }),
        /simulated final flush failure/,
      );
    });

    assert.equal(closeCount, 1);
    assert.equal(await readFile(target, "utf8"), "previous export\n");
    assert.deepEqual(await readdir(exportDir), ["existing.json"]);
  });
});

test("cursor fetch failure preserves an existing target and removes the temporary export", async () => {
  await withExportDir(async (exportDir) => {
    const target = path.join(exportDir, "existing.csv");
    await writeFile(target, "previous export\n");
    let closeCount = 0;
    const db = {
      async connection() {
        return {
          async execute() {
            return {
              metaData: [{ name: "ID" }],
              resultSet: {
                async getRows() { throw new Error("simulated cursor failure"); },
                async close() { closeCount++; },
              },
            };
          },
        };
      },
    };

    await assert.rejects(
      exportQuery(args("CSV", "existing.csv"), { db, config: config(exportDir) }),
      /simulated cursor failure/,
    );
    assert.equal(closeCount, 1);
    assert.equal(await readFile(target, "utf8"), "previous export\n");
    assert.deepEqual(await readdir(exportDir), ["existing.csv"]);
  });
});
