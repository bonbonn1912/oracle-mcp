/** B. SQL and PL/SQL execution tools. */

import { randomBytes } from "node:crypto";
import oracledb from "oracledb";
import type { Db } from "../db.js";
import { describeError } from "../db.js";
import { clamp, CONFIRM, preview, type ToolDef } from "../registry.js";
import {
  type Binds,
  cleanStatement,
  destructiveReason,
  isPlsql,
  isQuery,
  normalizeValue,
  parseBinds,
  splitScript,
  stripSql,
  ToolError,
} from "../util.js";

const TIMEOUT_PARAM = {
  type: "number" as const,
  description: "Timeout in seconds for long-running statements (default: ORACLE_CALL_TIMEOUT_MS, 60 s). 0 = no timeout.",
};

function applyTimeout(db: Db, seconds: number | undefined): void {
  if (seconds !== undefined && seconds >= 0) db.setCallTimeout(Math.floor(seconds * 1000));
}

const BINDS_PARAM = {
  type: "string" as const,
  description:
    'Bind values as a JSON string. Object for named binds, e.g. {"id": 7, "name": "A%"} for :id and :name, or an array for positional binds (:1, :2).',
};

/** Executes one statement of any kind and returns a uniform summary. */
export async function runStatement(
  db: Db,
  statement: string,
  binds: Binds,
  autoCommit: boolean,
  maxRows: number
): Promise<Record<string, unknown>> {
  const sql = cleanStatement(statement);
  if (isQuery(sql)) {
    const t = await db.table(sql, binds, maxRows);
    return { type: "query", ...t };
  }
  const res = await db.exec(sql, binds, autoCommit);
  const out: Record<string, unknown> = { type: isPlsql(sql) ? "plsql" : "statement", success: true };
  if (typeof res.rowsAffected === "number") out.rowsAffected = res.rowsAffected;
  const warning = (res as { warning?: { message?: string } }).warning;
  if (warning?.message) {
    out.warning = warning.message;
    out.hint = "Use oracle_list_invalid_objects to see the compilation errors.";
  }
  return out;
}

async function readDbmsOutput(db: Db, maxLines = 2000): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const res = await db.exec(
      "BEGIN DBMS_OUTPUT.GET_LINE(:ln, :st); END;",
      {
        ln: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 },
        st: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      } as unknown as Binds,
      false
    );
    const ob = res.outBinds as { ln: string | null; st: number };
    if (ob.st !== 0) return { lines, truncated: false };
    lines.push(ob.ln ?? "");
  }
  return { lines, truncated: true };
}

export const sqlTools: ToolDef[] = [
  {
    name: "oracle_query",
    description:
      "Runs one SELECT (or WITH ... SELECT) and returns columns and rows. Use binds for values. Results are capped (max_rows); use offset to page. For anything that is not a query use oracle_execute.",
    risk: "R",
    params: {
      sql: { type: "string", description: "A single SELECT statement, without trailing semicolon.", required: true },
      binds_json: BINDS_PARAM,
      max_rows: { type: "number", description: "Maximum rows to return (default and upper limit: ORACLE_MAX_ROWS, 200)." },
      offset: { type: "number", description: "Number of rows to skip before returning rows (default 0)." },
    },
    handler: async (a, { db, config }) => {
      const sql = cleanStatement(a.sql);
      if (!isQuery(sql)) {
        throw new ToolError("oracle_query only accepts SELECT / WITH statements. Use oracle_execute for DML, DDL or PL/SQL.");
      }
      const max = clamp(a.max_rows, config.maxRows, config.maxRows);
      const offset = Math.max(0, Math.floor(a.offset ?? 0));
      const res = await db.table(sql, parseBinds(a.binds_json), max, offset);
      return res.truncated
        ? { ...res, offset, note: `More rows available. Call again with offset=${offset + res.rowCount} or narrow the query.` }
        : { ...res, offset };
    },
  },
  {
    name: "oracle_execute",
    description:
      "Runs exactly one SQL statement of any kind: INSERT/UPDATE/DELETE/MERGE, DDL (CREATE/ALTER/DROP), GRANT, ALTER SYSTEM, CREATE PROCEDURE etc. This is the universal tool for everything without a dedicated tool. Destructive statements (DROP, TRUNCATE, PURGE, DELETE/UPDATE without WHERE, ALTER SYSTEM/DATABASE) need confirm=true.",
    risk: "D",
    params: {
      sql: { type: "string", description: "One SQL statement.", required: true },
      binds_json: BINDS_PARAM,
      autocommit: {
        type: "boolean",
        description: "Commit after the statement (default true). With false the transaction stays open until oracle_commit / oracle_rollback.",
      },
      timeout_seconds: TIMEOUT_PARAM,
      confirm: CONFIRM,
    },
    handler: async (a, { db, config }) => {
      const sql = cleanStatement(a.sql);
      if (stripSql(sql).trim() === "") throw new ToolError("sql is empty.");
      const reason = destructiveReason(sql);
      if (reason && !a.confirm) return preview([sql], { reason });
      applyTimeout(db, a.timeout_seconds);
      const result = await runStatement(db, sql, parseBinds(a.binds_json), a.autocommit ?? true, config.maxRows);
      return { executed: true, sql, ...result };
    },
  },
  {
    name: "oracle_execute_plsql",
    description:
      "Runs an anonymous PL/SQL block (BEGIN ... END; or DECLARE ...) and returns the DBMS_OUTPUT lines. Blocks containing DROP, TRUNCATE, PURGE or ALTER SYSTEM/DATABASE need confirm=true.",
    risk: "D",
    params: {
      block: { type: "string", description: "Anonymous PL/SQL block including the final END;", required: true },
      binds_json: BINDS_PARAM,
      capture_dbms_output: { type: "boolean", description: "Collect DBMS_OUTPUT (default true)." },
      autocommit: { type: "boolean", description: "Commit after the block (default true)." },
      timeout_seconds: TIMEOUT_PARAM,
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      let block = String(a.block).trim().replace(/\n\s*\/\s*$/, "").trim();
      if (!/^(BEGIN|DECLARE|<<)/i.test(stripSql(block).trim())) {
        throw new ToolError("block must start with BEGIN or DECLARE. For CREATE PROCEDURE etc. use oracle_execute.");
      }
      if (!/;\s*$/.test(block)) block += ";";
      const reason = destructiveReason(block);
      if (reason && !a.confirm) return preview([block], { reason });

      applyTimeout(db, a.timeout_seconds);
      const capture = a.capture_dbms_output ?? true;
      if (capture) await db.exec("BEGIN DBMS_OUTPUT.ENABLE(NULL); END;", {}, false);
      let error: unknown = null;
      try {
        await db.exec(block, parseBinds(a.binds_json), a.autocommit ?? true);
      } catch (e) {
        error = e;
      }
      let output: { lines: string[]; truncated: boolean } = { lines: [], truncated: false };
      if (capture) {
        try {
          output = await readDbmsOutput(db);
        } catch {
          /* session may be gone */
        }
      }
      if (error) {
        return { executed: true, success: false, ...describeError(error), dbmsOutput: output.lines };
      }
      return { executed: true, success: true, dbmsOutput: output.lines, dbmsOutputTruncated: output.truncated };
    },
  },
  {
    name: "oracle_run_script",
    description:
      "Runs a script with several statements, SQL*Plus style: ';' ends SQL statements, a line with only '/' ends PL/SQL blocks and CREATE PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE. SQL*Plus commands (SET, PROMPT, SPOOL...) are skipped. Returns one result per statement. Each statement is committed. If any statement is destructive, confirm=true is required.",
    risk: "D",
    params: {
      script: { type: "string", description: "Script text.", required: true },
      stop_on_error: { type: "boolean", description: "Stop at the first failing statement (default true)." },
      timeout_seconds: TIMEOUT_PARAM,
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const { statements, skipped } = splitScript(a.script);
      if (statements.length === 0) throw new ToolError("No executable statement found in script.", { skipped });
      const flagged = statements
        .map((s, i) => ({ index: i + 1, reason: destructiveReason(cleanStatement(s)) }))
        .filter((x) => x.reason);
      const short = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
      if (flagged.length && !a.confirm) {
        return preview(statements.map(short), { statementCount: statements.length, destructive: flagged, skipped });
      }
      applyTimeout(db, a.timeout_seconds);
      const stop = a.stop_on_error ?? true;
      const results: Record<string, unknown>[] = [];
      let failed = 0;
      for (let i = 0; i < statements.length; i++) {
        try {
          const r = await runStatement(db, statements[i], {}, true, 50);
          results.push({ index: i + 1, sql: short(statements[i]), ...r });
        } catch (e) {
          failed++;
          results.push({ index: i + 1, sql: short(statements[i]), success: false, ...describeError(e) });
          if (stop) break;
        }
      }
      return {
        executed: true,
        statementCount: statements.length,
        ran: results.length,
        failed,
        stoppedEarly: failed > 0 && stop && results.length < statements.length,
        skippedSqlplusCommands: skipped,
        results,
      };
    },
  },
  {
    name: "oracle_explain_plan",
    description:
      "Shows the execution plan of a statement via EXPLAIN PLAN and DBMS_XPLAN.DISPLAY without running it. Bind placeholders are not supported here; replace them with literals.",
    risk: "R",
    params: {
      sql: { type: "string", description: "Statement to explain (SELECT, INSERT, UPDATE, DELETE, MERGE).", required: true },
      format: { type: "string", description: "Plan detail level (default TYPICAL).", enum: ["BASIC", "TYPICAL", "ALL"] },
    },
    handler: async (a, { db }) => {
      const sql = cleanStatement(a.sql);
      const id = `MCP_${randomBytes(6).toString("hex").toUpperCase()}`;
      const hadTx = await db.transactionOpen();
      await db.exec(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql}`, {}, false);
      try {
        const res = await db.rows(
          "SELECT plan_table_output AS line FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, :id, :fmt))",
          { id, fmt: a.format ?? "TYPICAL" }
        );
        return { plan: res.map((r) => String(normalizeValue(r.line, false) ?? "")).join("\n") };
      } finally {
        try {
          await db.exec("DELETE FROM plan_table WHERE statement_id = :id", { id }, false);
          if (!hadTx) await db.commit();
        } catch {
          /* best effort */
        }
      }
    },
  },
];
