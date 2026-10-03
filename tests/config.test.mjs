import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings } from '../dist/config.js';

test('readOnly config accepts documented boolean forms and rejects invalid explicit values', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'oracle-config-test-'));
  const configPath = path.join(temp, 'connections.json');
  const envPath = path.join(temp, 'empty.env');
  writeFileSync(envPath, '');

  const names = [
    'ORACLE_CONNECTIONS_FILE', 'ORACLE_ENV_FILE', 'ORACLE_READ_ONLY',
    'ORACLE_DEFAULT_CONNECTION', 'ORACLE_PASSWORD', 'ORACLE_MAX_ROWS',
    'ORACLE_CALL_TIMEOUT_MS', 'ORACLE_EXPORT_DIR',
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.ORACLE_CONNECTIONS_FILE = configPath;
  process.env.ORACLE_ENV_FILE = envPath;

  const setConfig = (entry) => writeFileSync(configPath, JSON.stringify({
    connections: { server: { user: 'test_user', connectString: 'db.example/XEPDB1', ...entry } },
  }));

  try {
    await t.test('keeps the read-only default for server connections', () => {
      setConfig({});
      assert.equal(loadSettings().connections.get('server').readOnly, true);
    });

    await t.test('accepts true and false variants', () => {
      for (const [value, expected] of [
        [true, true], [false, false], ['TRUE', true], ['yes', true], ['On', true], [1, true],
        ['false', false], ['NO', false], ['off', false], [0, false],
      ]) {
        setConfig({ readOnly: value });
        assert.equal(loadSettings().connections.get('server').readOnly, expected, `readOnly=${JSON.stringify(value)}`);
      }
    });

    await t.test('fails closed for invalid values with connection and field context', () => {
      for (const value of ['tru', '', null, 2, 'sometimes']) {
        setConfig({ readOnly: value });
        assert.throws(
          () => loadSettings(),
          (error) => error instanceof Error && /connections\.json/.test(error.message) && /server/.test(error.message) && /readOnly/.test(error.message),
          `readOnly=${JSON.stringify(value)} should be rejected`,
        );
      }
    });

    await t.test('reports invalid global environment values', () => {
      process.env.ORACLE_READ_ONLY = 'tru';
      setConfig({});
      assert.throws(() => loadSettings(), /ORACLE_READ_ONLY: must be a boolean/);
      process.env.ORACLE_READ_ONLY = '';
      assert.throws(() => loadSettings(), /ORACLE_READ_ONLY: must be a boolean/);
      delete process.env.ORACLE_READ_ONLY;
    });

    await t.test('validates connection values even when global read-only is enabled', () => {
      process.env.ORACLE_READ_ONLY = 'true';
      setConfig({ readOnly: 'tru' });
      assert.throws(
        () => loadSettings(),
        /connections\.json.*server.*readOnly: must be a boolean/,
      );
      delete process.env.ORACLE_READ_ONLY;
    });
  } finally {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
