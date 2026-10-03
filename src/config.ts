/**
 * Configuration: all connections live in connections.json next to dist/, their passwords in the
 * .env file next to it. The default connection "local" also works without an entry
 * (sys@localhost:1521/XEPDB1 as SYSDBA).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** Connection name as used by the tools, e.g. "local" or "test-server". */
  name: string;
  description: string;
  user: string;
  /** Empty when no password is configured; connecting then fails with a message naming passwordVar. */
  password: string;
  /** Environment variable / .env key the password is read from. */
  passwordVar: string;
  connectString: string;
  privilege: "SYSDBA" | "SYSOPER" | "";
  readOnly: boolean;
  maxRows: number;
  callTimeoutMs: number;
  exportDir: string;
  /** Which dictionary views to use: dba (DBA_*), all (ALL_*, for ordinary users) or auto-detect. */
  dictionary: "auto" | "dba" | "all";
}

export interface Settings {
  connections: Map<string, Config>;
  defaultName: string;
  connectionsFile: string;
}

export const LOCAL = "local";

export function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** The .env file sits in the project folder, next to dist/. */
export function dotEnvPath(): string {
  return path.resolve(projectRoot(), process.env.ORACLE_ENV_FILE?.trim() || ".env");
}

export function connectionsFilePath(): string {
  return path.resolve(projectRoot(), process.env.ORACLE_CONNECTIONS_FILE?.trim() || "connections.json");
}

/** Gemini leaves "${VAR}" untouched when VAR is not set; treat that as "not set". */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === "" || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v)) return undefined;
  return v;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return Math.floor(n);
}

/**
 * Reads KEY=VALUE lines from the .env file. Values that are already set in the environment
 * (e.g. via the env block of settings.json) win; unresolved "${VAR}" placeholders count as not set.
 */
function loadDotEnv(): void {
  const file = dotEnvPath();
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    if (env(m[1]) === undefined) process.env[m[1]] = value;
  }
}

function privilegeOf(raw: string | undefined, user: string, what: string): Config["privilege"] {
  let p = (raw ?? "").trim().toUpperCase();
  if (raw === undefined && user.toLowerCase() === "sys") p = "SYSDBA";
  if (p === "NONE" || p === "NORMAL") p = "";
  if (p !== "" && p !== "SYSDBA" && p !== "SYSOPER") {
    throw new Error(`${what}: privilege must be SYSDBA, SYSOPER or empty, got "${raw}"`);
  }
  return p as Config["privilege"];
}

function dictionaryOf(raw: string | undefined, what: string): Config["dictionary"] {
  const d = (raw ?? "auto").trim().toLowerCase();
  if (d !== "auto" && d !== "dba" && d !== "all") throw new Error(`${what}: dictionary must be auto, dba or all, got "${raw}"`);
  return d;
}

function boolOf(v: unknown, fallback: boolean, what: string): boolean {
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && (v === 0 || v === 1)) return v === 1;
  if (typeof v === "string") {
    const value = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
  }
  throw new Error(`${what}: must be a boolean (true/false, yes/no, on/off or 1/0), got ${JSON.stringify(v)}`);
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

export function loadSettings(): Settings {
  loadDotEnv();

  const maxRows = intEnv("ORACLE_MAX_ROWS", 200);
  const callTimeoutMs = intEnv("ORACLE_CALL_TIMEOUT_MS", 60000);
  const exportDir = env("ORACLE_EXPORT_DIR") ?? "./exports";
  const rawReadOnly = process.env.ORACLE_READ_ONLY;
  const globalReadOnly = boolOf(
    rawReadOnly !== undefined && rawReadOnly.trim() === "" ? rawReadOnly : env("ORACLE_READ_ONLY"),
    false,
    "ORACLE_READ_ONLY",
  );

  const connections = new Map<string, Config>();

  // ---- default connection "local": built-in defaults, overridden by a "local" entry in the file
  const user = "sys";
  const host = "localhost";
  const port = "1521";
  const service = "XEPDB1";
  connections.set(LOCAL, {
    name: LOCAL,
    description: "Local database (default)",
    user,
    password: env("ORACLE_PASSWORD") ?? "",
    passwordVar: "ORACLE_PASSWORD",
    connectString: `${host}:${port}/${service}`,
    privilege: "SYSDBA",
    readOnly: globalReadOnly,
    maxRows,
    callTimeoutMs,
    exportDir,
    dictionary: "auto",
  });

  // ---- additional server connections from connections.json ---------------------------------
  const file = connectionsFilePath();
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
    }
    const root = parsed as { connections?: unknown };
    const entries =
      root && typeof root === "object" && root.connections && typeof root.connections === "object"
        ? (root.connections as Record<string, unknown>)
        : null;
    if (!entries) throw new Error(`${file} must look like { "connections": { "<name>": { ... } } }`);

    for (const [rawName, rawEntry] of Object.entries(entries)) {
      const name = rawName.trim().toLowerCase();
      const what = `${path.basename(file)} → "${rawName}"`;
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
        throw new Error(`${what}: connection names may only contain letters, digits, "-" and "_" (max 40 characters)`);
      }
      if (!rawEntry || typeof rawEntry !== "object") throw new Error(`${what}: must be an object`);
      const e = rawEntry as Record<string, unknown>;

      if (name === LOCAL) {
        // "local" in the file overrides the built-in defaults; every field is optional
        const base = connections.get(LOCAL) as Config;
        const lUser = str(e.user) ?? base.user;
        let lConnect = str(e.connectString);
        if (!lConnect && (str(e.host) || str(e.port) || str(e.service))) {
          lConnect = `${str(e.host) ?? host}:${str(e.port) ?? port}/${str(e.service) ?? service}`;
        }
        const lPasswordVar = str(e.passwordEnv) ?? base.passwordVar;
        const lMaxRows = Number(e.maxRows);
        connections.set(LOCAL, {
          ...base,
          description: str(e.description) ?? base.description,
          user: lUser,
          password: str(e.password) ?? env(lPasswordVar) ?? "",
          passwordVar: lPasswordVar,
          connectString: lConnect ?? base.connectString,
          privilege:
            e.privilege !== undefined
              ? privilegeOf(str(e.privilege) ?? "", lUser, what)
              : privilegeOf(undefined, lUser, what),
          readOnly: boolOf(e.readOnly, false, `${what}: readOnly`) || globalReadOnly,
          maxRows: Number.isFinite(lMaxRows) && lMaxRows > 0 ? Math.floor(lMaxRows) : base.maxRows,
          dictionary: e.dictionary !== undefined ? dictionaryOf(str(e.dictionary), what) : base.dictionary,
        });
        continue;
      }
      if (connections.has(name)) throw new Error(`${what}: duplicate connection name`);

      const cUser = str(e.user);
      if (!cUser) throw new Error(`${what}: "user" is required`);
      let connectString = str(e.connectString);
      if (!connectString) {
        const cHost = str(e.host);
        const cService = str(e.service);
        if (!cHost || !cService) throw new Error(`${what}: set "host" and "service" (plus optional "port") or "connectString"`);
        connectString = `${cHost}:${str(e.port) ?? "1521"}/${cService}`;
      }
      const passwordVar = str(e.passwordEnv) ?? `ORACLE_PASSWORD_${name.toUpperCase().replace(/-/g, "_")}`;
      const cMaxRows = Number(e.maxRows);

      connections.set(name, {
        name,
        description: str(e.description) ?? "",
        user: cUser,
        password: str(e.password) ?? env(passwordVar) ?? "",
        passwordVar,
        connectString,
        privilege: privilegeOf(str(e.privilege) ?? "", cUser, what),
        // servers are read-only unless the entry says "readOnly": false
        readOnly: boolOf(e.readOnly, true, `${what}: readOnly`) || globalReadOnly,
        maxRows: Number.isFinite(cMaxRows) && cMaxRows > 0 ? Math.floor(cMaxRows) : maxRows,
        callTimeoutMs,
        exportDir,
        dictionary: dictionaryOf(str(e.dictionary), what),
      });
    }
  }

  const defaultName = (env("ORACLE_DEFAULT_CONNECTION") ?? LOCAL).toLowerCase();
  if (!connections.has(defaultName)) {
    throw new Error(`ORACLE_DEFAULT_CONNECTION="${defaultName}" is not a configured connection (${[...connections.keys()].join(", ")})`);
  }
  return { connections, defaultName, connectionsFile: file };
}
