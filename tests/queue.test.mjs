import assert from "node:assert/strict";
import test from "node:test";
import { RequestCancelledError, SerialQueue } from "../dist/queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a cancelled queued task is skipped and later tasks still run", async () => {
  const queue = new SerialQueue();
  const gate = deferred();
  const effects = [];
  const first = queue.enqueue(async () => {
    effects.push("first-start");
    await gate.promise;
    effects.push("first-end");
  });
  const controller = new AbortController();
  const cancelled = queue.enqueue(async () => effects.push("cancelled-write"), controller.signal);
  const later = queue.enqueue(async () => effects.push("later"));

  controller.abort();
  gate.resolve();
  await first;
  await assert.rejects(cancelled, RequestCancelledError);
  await later;

  assert.deepEqual(effects, ["first-start", "first-end", "later"]);
});

test("a failed task does not poison the serial queue", async () => {
  const queue = new SerialQueue();
  const effects = [];
  const failed = queue.enqueue(async () => {
    effects.push("failed");
    throw new Error("expected failure");
  });
  const later = queue.enqueue(async () => effects.push("later"));

  await assert.rejects(failed, /expected failure/);
  await later;
  assert.deepEqual(effects, ["failed", "later"]);
});
