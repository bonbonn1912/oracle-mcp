import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function waitFor(items, predicate, label, timeoutMs = 8000) {
  if (items.failure) return Promise.reject(items.failure);
  const existing = items.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      items.off("item", check);
      items.off("failure", fail);
    };
    const check = (item) => {
      if (!predicate(item)) return;
      cleanup();
      resolve(item);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    items.on("item", check);
    items.on("failure", fail);
  });
}

test("stdio server skips a cancelled queued confirmed write and continues serving", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "oracle-mcp-cancel-test-"));
  const envFile = path.join(temp, ".env");
  const connectionsFile = path.join(temp, "connections.json");
  await writeFile(envFile, "");
  await writeFile(
    connectionsFile,
    JSON.stringify({
      connections: {
        local: {
          user: "test_user",
          passwordEnv: "TEST_ORACLE_PASSWORD",
          connectString: "mock.invalid:1521/TEST",
          privilege: "none",
          dictionary: "all",
          readOnly: false,
        },
      },
    })
  );

  const child = fork(path.join(root, "dist/index.js"), [], {
    cwd: root,
    env: {
      ...process.env,
      ORACLE_ENV_FILE: envFile,
      ORACLE_CONNECTIONS_FILE: connectionsFile,
      ORACLE_DEFAULT_CONNECTION: "local",
      ORACLE_READ_ONLY: "false",
      ORACLE_MAX_ROWS: "200",
      ORACLE_CALL_TIMEOUT_MS: "60000",
      TEST_ORACLE_PASSWORD: "test-only",
    },
    execArgv: ["--import", path.join(root, "tests/helpers/mock-oracle.mjs")],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      let timer;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("MCP server did not exit during test cleanup")), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await rm(temp, { recursive: true, force: true });
  });

  const tracked = () => {
    const items = [];
    const emitter = new EventEmitter();
    items.on = emitter.on.bind(emitter);
    items.off = emitter.off.bind(emitter);
    items.emit = emitter.emit.bind(emitter);
    items.add = (item) => {
      items.push(item);
      emitter.emit("item", item);
    };
    return items;
  };
  const ipc = tracked();
  const protocol = tracked();
  child.once("exit", (code, signal) => {
    const error = new Error(`MCP server exited (code=${code}, signal=${signal}); stderr: ${stderr}`);
    for (const items of [ipc, protocol]) {
      items.failure = error;
      items.emit("failure", error);
    }
  });

  child.on("message", (item) => {
    ipc.add(item);
  });
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      protocol.add(JSON.parse(line));
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const response = (id) => waitFor(protocol, (m) => m.id === id, `JSON-RPC response ${id}`);

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  const initialized = await response(1);
  assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "oracle_query", arguments: { sql: "SELECT 'BLOCK_QUEUE_TEST' AS value FROM dual" } },
  });
  await waitFor(ipc, (m) => m.type === "blocked", "first query to block");

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "oracle_execute",
      arguments: { sql: "UPDATE test_table SET value = 1 WHERE id = 1", confirm: true },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 3, reason: "cancel queued write" },
  });
  send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  const barrier = await response(4);
  assert.equal(barrier.error, undefined, JSON.stringify(barrier.error));

  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "oracle_query", arguments: { sql: "SELECT 'AFTER_QUEUE_TEST' AS value FROM dual" } },
  });
  child.send({ type: "release-first-query" });

  const first = await response(2);
  assert.equal(first.error, undefined, `${JSON.stringify(first.error)}; stderr: ${stderr}`);
  assert.notEqual(first.result?.isError, true, JSON.stringify(first.result));
  const firstPayload = JSON.parse(first.result.content[0].text);
  assert.equal(firstPayload.rowCount, 1);
  assert.deepEqual(firstPayload.rows, [["ok"]]);
  const later = await response(5);
  assert.equal(later.error, undefined, `${JSON.stringify(later.error)}; stderr: ${stderr}`);
  assert.notEqual(later.result?.isError, true, JSON.stringify(later.result));
  const laterPayload = JSON.parse(later.result.content[0].text);
  assert.equal(laterPayload.rowCount, 1);
  assert.deepEqual(laterPayload.rows, [["ok"]]);
  assert.equal(child.exitCode, null, `server exited unexpectedly; stderr: ${stderr}`);
  assert.equal(
    ipc.some((m) => m.type === "sql" && /^\s*UPDATE\s+test_table/i.test(m.sql)),
    false,
    `cancelled UPDATE reached Oracle; statements: ${JSON.stringify(ipc.filter((m) => m.type === "sql"))}`
  );
});
