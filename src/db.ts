/** One long-lived database session with helpers for queries and statements. */

import oracledb from "oracledb";
import { type Config, dotEnvPath } from "./config.js";
import { type Binds, normalizeValue, ToolError } from "./util.js";

oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];
oracledb.fetchAsBuffer = [oracledb.BLOB];

export interface TableResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export interface ListResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export type Row = Record<string, any>;

const CONNECTION_LOST = new Set([28, 1012, 1033, 1034, 1089, 3113, 3114, 3135, 12537, 12541, 12514, 12547, 12570]);

function isConnectionLost(err: unknown): boolean {
  const e = err as { errorNum?: number; code?: string; message?: string };
  if (typeof e?.errorNum === "number" && CONNECTION_LOST.has(e.errorNum)) return true;
  const code = String(e?.code ?? "");
  if (/^NJS-(003|500|501|503|511|521)$/.test(code)) return true;
  return /DPI-1010|DPI-1080|not connected|connection (was )?closed|ECONNRESET|EPIPE/i.test(String(e?.message ?? ""));
}

export class Db {
  private conn: oracledb.Connection | null = null;
  /** Set when a previous session died; reported once so the model knows session state is gone. */
  public reconnectNotice: string | null = null;
  private hadConnection = false;
  private timeoutOverrideMs: number | null = null;
  private dictMode: "dba" | "all" | null = null;

  constructor(public readonly config: Config) {}

  get isOpen(): boolean {
    return this.conn !== null;
  }

  async connection(): Promise<oracledb.Connection> {
    if (this.conn) {
      let healthy = true;
      try {
        healthy = this.conn.isHealthy();
      } catch {
        healthy = false;
      }
      if (healthy) return this.conn;
      await this.drop();
    }
    if (!this.config.password) {
      throw new ToolError(
        `No password configured for connection "${this.config.name}". Put ${this.config.passwordVar}=... into ${dotEnvPath()}` +
          (this.config.passwordVar === "ORACLE_PASSWORD" ? " or into the env block of the MCP server entry in settings.json." : ".")
      );
    }
    const attrs: oracledb.ConnectionAttributes = {
      user: this.config.user,
      password: this.config.password,
      connectString: this.config.connectString,
    };
    if (this.config.privilege === "SYSDBA") attrs.privilege = oracledb.SYSDBA;
    if (this.config.privilege === "SYSOPER") attrs.privilege = oracledb.SYSOPER;

    const conn = await oracledb.getConnection(attrs);
    conn.callTimeout = this.timeoutOverrideMs ?? this.config.callTimeoutMs;
    try {
      conn.module = "oracle-mcp";
    } catch {
      /* optional */
    }
    if (this.hadConnection) {
      this.reconnectNotice =
        "The database session was lost and has been re-established. Container, CURRENT_SCHEMA and any open transaction of the old session are gone.";
    }
    this.hadConnection = true;
    this.conn = conn;
    return conn;
  }

  /** Overrides the per-round-trip timeout (0 = no timeout); null restores the configured value. */
  setCallTimeout(ms: number | null): void {
    this.timeoutOverrideMs = ms;
    if (this.conn) {
      try {
        this.conn.callTimeout = ms ?? this.config.callTimeoutMs;
      } catch {
        /* connection is being replaced */
      }
    }
  }

  /**
   * "dba" when the session may read the DBA_* dictionary views, otherwise "all": then the ALL_* views
   * are used, which only show what the connected user is allowed to see.
   */
  async dict(): Promise<"dba" | "all"> {
    if (this.config.dictionary !== "auto") return this.config.dictionary;
    if (this.dictMode) return this.dictMode;
    try {
      await this.exec("SELECT 1 FROM dba_users WHERE ROWNUM = 1", {}, false);
      this.dictMode = "dba";
    } catch (err) {
      const num = (err as { errorNum?: number }).errorNum;
      if (num !== 942 && num !== 1031) throw err;
      this.dictMode = "all";
    }
    return this.dictMode;
  }

  private async drop(): Promise<void> {
    const c = this.conn;
    this.conn = null;
    this.dictMode = null;
    if (c) {
      try {
        await c.close();
      } catch {
        /* already gone */
      }
    }
  }

  async close(): Promise<void> {
    await this.drop();
  }

  private async run<T>(fn: (conn: oracledb.Connection) => Promise<T>): Promise<T> {
    const conn = await this.connection();
    try {
      return await fn(conn);
    } catch (err) {
      if (isConnectionLost(err)) await this.drop();
      throw err;
    }
  }

  /** Runs any statement. Returns the raw driver result. */
  async exec(sql: string, binds: Binds = {}, autoCommit = true): Promise<oracledb.Result<unknown>> {
    return this.run(async (conn) => {
      try {
        return await conn.execute(sql, binds as oracledb.BindParameters, {
          autoCommit,
          outFormat: oracledb.OUT_FORMAT_ARRAY,
        });
      } catch (err) {
        (err as { sql?: string }).sql = sql;
        throw err;
      }
    });
  }

  /** Query returning objects with lower-case keys. Fetches at most `max` rows. */
  async list(sql: string, binds: Binds = {}, max = 0): Promise<ListResult> {
    const limit = max > 0 ? max : this.config.maxRows;
    return this.run(async (conn) => {
      let res: oracledb.Result<unknown[]>;
      try {
        res = await conn.execute<unknown[]>(sql, binds as oracledb.BindParameters, {
          maxRows: limit + 1,
          outFormat: oracledb.OUT_FORMAT_ARRAY,
        });
      } catch (err) {
        (err as { sql?: string }).sql = sql;
        throw err;
      }
      const names = (res.metaData ?? []).map((m) => m.name.toLowerCase());
      const all = res.rows ?? [];
      const truncated = all.length > limit;
      const rows = (truncated ? all.slice(0, limit) : all).map((r) => {
        const o: Record<string, unknown> = {};
        names.forEach((n, i) => (o[n] = normalizeValue(r[i])));
        return o;
      });
      return { rows, rowCount: rows.length, truncated };
    });
  }

  /** All rows as objects with lower-case keys (internal dictionary lookups, capped at 5000). */
  async rows(sql: string, binds: Binds = {}): Promise<Row[]> {
    return (await this.list(sql, binds, 5000)).rows as Row[];
  }

  async one(sql: string, binds: Binds = {}): Promise<Row | undefined> {
    return (await this.list(sql, binds, 1)).rows[0] as Row | undefined;
  }

  /** First column of the first row. */
  async scalar<T = unknown>(sql: string, binds: Binds = {}): Promise<T | null> {
    const row = await this.one(sql, binds);
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.length ? (row[keys[0]] as T) : null;
  }

  /** User query with offset / limit, column-oriented output. */
  async table(sql: string, binds: Binds, maxRows: number, offset = 0): Promise<TableResult> {
    return this.run(async (conn) => {
      let res: oracledb.Result<unknown[]>;
      try {
        res = await conn.execute<unknown[]>(sql, binds as oracledb.BindParameters, {
          resultSet: true,
          outFormat: oracledb.OUT_FORMAT_ARRAY,
          fetchArraySize: Math.min(Math.max(maxRows + 1, 50), 1000),
        });
      } catch (err) {
        (err as { sql?: string }).sql = sql;
        throw err;
      }
      const rs = res.resultSet;
      if (!rs) throw new ToolError("Statement did not return a result set.");
      try {
        const columns = (res.metaData ?? rs.metaData ?? []).map((m) => m.name);
        let toSkip = Math.max(0, offset);
        while (toSkip > 0) {
          const chunk = await rs.getRows(Math.min(toSkip, 1000));
          if (chunk.length === 0) break;
          toSkip -= chunk.length;
        }
        const fetched = toSkip > 0 ? [] : await rs.getRows(maxRows + 1);
        const truncated = fetched.length > maxRows;
        const rows = (truncated ? fetched.slice(0, maxRows) : fetched).map((r) =>
          (r as unknown[]).map((v) => normalizeValue(v))
        );
        return { columns, rows, rowCount: rows.length, truncated };
      } finally {
        try {
          await rs.close();
        } catch {
          /* ignore */
        }
      }
    });
  }

  async commit(): Promise<void> {
    await this.run((conn) => conn.commit());
  }

  async rollback(): Promise<void> {
    await this.run((conn) => conn.rollback());
  }

  async transactionOpen(): Promise<boolean> {
    const id = await this.scalar<string>("SELECT DBMS_TRANSACTION.LOCAL_TRANSACTION_ID AS tx FROM dual");
    return id !== null;
  }

  // ---- dictionary helpers used by several tools --------------------------------------------

  async isOracleMaintained(dictSchema: string): Promise<boolean> {
    const row = await this.one("SELECT oracle_maintained FROM dba_users WHERE username = :u", { u: dictSchema });
    if (!row) throw new ToolError(`Schema/user ${dictSchema} does not exist in the current container.`);
    return row.oracle_maintained === "Y";
  }

  async assertUserSchema(dictSchema: string, action: string): Promise<void> {
    if (await this.isOracleMaintained(dictSchema)) {
      throw new ToolError(
        `${dictSchema} is an Oracle-maintained schema; ${action} is blocked in this tool. Use oracle_execute if you really need it.`
      );
    }
  }

  async currentContainer(): Promise<string> {
    return (await this.scalar<string>("SELECT SYS_CONTEXT('USERENV','CON_NAME') AS c FROM dual")) ?? "";
  }
}

export interface OraErrorInfo {
  error: string;
  message: string;
  sql?: string;
  offset?: number;
  details?: Record<string, unknown>;
}

export function describeError(err: unknown): OraErrorInfo {
  if (err instanceof ToolError) {
    return { error: "TOOL_ERROR", message: err.message, ...(err.details ? { details: err.details } : {}) };
  }
  const e = err as { errorNum?: number; code?: string; message?: string; offset?: number; sql?: string };
  const message = String(e?.message ?? err);
  const code =
    e?.code ??
    (typeof e?.errorNum === "number" && e.errorNum > 0 ? `ORA-${String(e.errorNum).padStart(5, "0")}` : undefined) ??
    /\b(ORA|NJS|DPI|TNS|PLS)-\d+/.exec(message)?.[0] ??
    "ERROR";
  const info: OraErrorInfo = { error: code, message };
  if (e?.sql) info.sql = e.sql.length > 2000 ? `${e.sql.slice(0, 2000)}…` : e.sql;
  if (typeof e?.offset === "number" && e.offset > 0) info.offset = e.offset;
  return info;
}
