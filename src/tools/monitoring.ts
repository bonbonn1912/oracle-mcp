/** G. Operations and monitoring. */

import { clamp, CONFIRM, preview, type ToolDef } from "../registry.js";
import { dictName, likePattern, lit, plainName, ToolError } from "../util.js";

const TOP_SQL_ORDER: Record<string, string> = {
  ELAPSED: "elapsed_time",
  CPU: "cpu_time",
  READS: "disk_reads",
  EXECUTIONS: "executions",
};

export const monitoringTools: ToolDef[] = [
  {
    name: "oracle_list_sessions",
    description:
      "Lists user sessions with SID and SERIAL#, user, program, status, current wait event, blocking session and the SQL currently running. is_me marks the session of this MCP server.",
    risk: "R",
    params: {
      username: { type: "string", description: "Only sessions of this database user." },
      only_active: { type: "boolean", description: "Only sessions in status ACTIVE (default false)." },
    },
    handler: async (a, { db, config }) =>
      db.list(
        `SELECT s.sid, s.serial# AS serial, s.username, s.status, s.osuser, s.machine, s.program, s.module,
                s.logon_time, s.last_call_et AS seconds_in_state, s.event, s.wait_class, s.blocking_session,
                s.sql_id, SUBSTR(q.sql_text, 1, 300) AS sql_text,
                CASE WHEN s.sid = TO_NUMBER(SYS_CONTEXT('USERENV', 'SID')) THEN 'Y' ELSE 'N' END AS is_me
           FROM v$session s
           LEFT JOIN v$sqlarea q ON q.sql_id = s.sql_id
          WHERE s.type = 'USER'
            AND (:u IS NULL OR s.username = :u)
            AND (:a = 0 OR s.status = 'ACTIVE')
          ORDER BY CASE s.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, s.last_call_et DESC`,
        { u: a.username ? dictName(a.username, "username") : null, a: a.only_active ? 1 : 0 },
        config.maxRows
      ),
  },
  {
    name: "oracle_kill_session",
    description:
      "Terminates a session (ALTER SYSTEM KILL SESSION 'sid,serial#'). Its open transaction is rolled back. Get SID and SERIAL# from oracle_list_sessions. The session of this MCP server cannot be killed.",
    risk: "D",
    params: {
      sid: { type: "number", description: "Session id (SID).", required: true },
      serial: { type: "number", description: "Session serial number (SERIAL#).", required: true },
      immediate: { type: "boolean", description: "Add IMMEDIATE: do not wait for the session to finish its call (default true)." },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const sid = Math.floor(a.sid);
      const serial = Math.floor(a.serial);
      if (sid < 0 || serial < 0) throw new ToolError("sid and serial must be positive numbers.");
      const session = await db.one(
        `SELECT sid, serial# AS serial, username, status, osuser, machine, program, type,
                CASE WHEN sid = TO_NUMBER(SYS_CONTEXT('USERENV', 'SID')) THEN 'Y' ELSE 'N' END AS is_me
           FROM v$session WHERE sid = :sid AND serial# = :ser`,
        { sid, ser: serial }
      );
      if (!session) throw new ToolError(`No session with SID ${sid} and SERIAL# ${serial}. Use oracle_list_sessions.`);
      if (session.is_me === "Y") throw new ToolError("This is the session of the MCP server itself; refusing to kill it.");
      if (session.type !== "USER") throw new ToolError("This is a background process session; killing it can crash the instance.");
      const sql = `ALTER SYSTEM KILL SESSION '${sid},${serial}'${(a.immediate ?? true) ? " IMMEDIATE" : ""}`;
      if (!a.confirm) return preview([sql], { impact: { session } });
      await db.exec(sql);
      return { executed: true, statement: sql, killed: session };
    },
  },
  {
    name: "oracle_list_locks",
    description:
      "Shows blocking situations (who waits for whom, on which object) and the DML locks currently held on tables. Use it when statements hang.",
    risk: "R",
    params: {},
    handler: async (_a, { db, config }) => {
      const blocking = await db.rows(
        `SELECT w.sid AS waiting_sid, w.serial# AS waiting_serial, w.username AS waiting_user, w.event,
                w.seconds_in_wait, w.sql_id AS waiting_sql_id,
                b.sid AS blocking_sid, b.serial# AS blocking_serial, b.username AS blocking_user,
                b.status AS blocking_status, b.program AS blocking_program,
                (SELECT MAX(o.owner || '.' || o.object_name) FROM dba_objects o WHERE o.object_id = w.row_wait_obj#) AS locked_object
           FROM v$session w
           JOIN v$session b ON b.sid = w.blocking_session
          WHERE w.blocking_session IS NOT NULL
          ORDER BY w.seconds_in_wait DESC`
      );
      const held = await db.list(
        `SELECT l.session_id AS sid, s.serial# AS serial, s.username, s.status, o.owner, o.object_name, o.object_type,
                DECODE(l.locked_mode, 0, 'NONE', 1, 'NULL', 2, 'ROW SHARE', 3, 'ROW EXCLUSIVE',
                                      4, 'SHARE', 5, 'SHARE ROW EXCLUSIVE', 6, 'EXCLUSIVE') AS lock_mode
           FROM v$locked_object l
           JOIN dba_objects o ON o.object_id = l.object_id
           JOIN v$session s ON s.sid = l.session_id
          ORDER BY l.session_id, o.owner, o.object_name`,
        {},
        config.maxRows
      );
      return {
        blocking,
        lockedObjects: held.rows,
        hint: blocking.length ? "Resolve by committing/rolling back in the blocking session or with oracle_kill_session." : undefined,
      };
    },
  },
  {
    name: "oracle_top_sql",
    description:
      "The most expensive SQL statements currently in the shared pool (V$SQLAREA), ordered by elapsed time, CPU, disk reads or executions. Needs no Diagnostics Pack.",
    risk: "R",
    params: {
      order_by: { type: "string", description: "Sort criterion (default ELAPSED).", enum: ["ELAPSED", "CPU", "READS", "EXECUTIONS"] },
      top_n: { type: "number", description: "Number of statements (default 15)." },
    },
    handler: async (a, { db }) => {
      const col = TOP_SQL_ORDER[a.order_by ?? "ELAPSED"];
      return db.list(
        `SELECT sql_id, parsing_schema_name, executions,
                ROUND(elapsed_time/1000000, 2) AS elapsed_s,
                ROUND(cpu_time/1000000, 2) AS cpu_s,
                ROUND(elapsed_time/1000000/NULLIF(executions, 0), 4) AS avg_elapsed_s,
                disk_reads, buffer_gets, rows_processed, last_active_time,
                SUBSTR(sql_text, 1, 400) AS sql_text
           FROM v$sqlarea
          ORDER BY ${col} DESC`,
        {},
        clamp(a.top_n, 15, 100)
      );
    },
  },
  {
    name: "oracle_get_parameters",
    description:
      "Shows initialization parameters (V$PARAMETER) with current value, SPFILE value, whether they are default and whether they can be changed without restart.",
    risk: "R",
    params: {
      name_like: { type: "string", description: "Filter on the parameter name, e.g. sga, processes, %target%." },
      only_modified: { type: "boolean", description: "Only parameters that differ from their default (default false)." },
    },
    handler: async (a, { db, config }) =>
      db.list(
        `SELECT p.name, p.display_value AS value, p.isdefault AS is_default,
                p.issys_modifiable AS system_modifiable, p.isses_modifiable AS session_modifiable,
                p.ispdb_modifiable AS pdb_modifiable,
                (SELECT LISTAGG(sp.display_value, ', ') WITHIN GROUP (ORDER BY sp.ordinal)
                   FROM v$spparameter sp WHERE sp.name = p.name AND sp.isspecified = 'TRUE') AS spfile_value,
                p.description
           FROM v$parameter p
          WHERE (:pat IS NULL OR p.name LIKE LOWER(:pat))
            AND (:m = 0 OR p.isdefault = 'FALSE')
          ORDER BY p.name`,
        { pat: likePattern(a.name_like), m: a.only_modified ? 1 : 0 },
        Math.max(config.maxRows, 500)
      ),
  },
  {
    name: "oracle_set_parameter",
    description:
      "Changes an initialization parameter with ALTER SYSTEM SET. scope MEMORY = until restart, SPFILE = after restart, BOTH = now and persistent. Check system_modifiable in oracle_get_parameters first: FALSE means only SPFILE works.",
    risk: "D",
    params: {
      name: { type: "string", description: "Parameter name, e.g. open_cursors.", required: true },
      value: { type: "string", description: "New value, e.g. 500, 2G, TRUE or a text value.", required: true },
      scope: { type: "string", description: "Scope (default BOTH).", enum: ["MEMORY", "SPFILE", "BOTH"] },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const name = plainName(a.name, "parameter name").toLowerCase();
      const raw = String(a.value).trim();
      const value = /^[A-Za-z0-9_.+-]+$/.test(raw) ? raw : lit(raw);
      const current = await db.one(
        "SELECT name, display_value AS value, isdefault AS is_default, issys_modifiable AS system_modifiable FROM v$parameter WHERE name = :n",
        { n: name }
      );
      if (!current && !name.startsWith("_")) throw new ToolError(`Unknown parameter "${name}". Use oracle_get_parameters.`);
      const sqlName = name.startsWith("_") ? `"${name}"` : name;
      const sql = `ALTER SYSTEM SET ${sqlName} = ${value} SCOPE = ${a.scope ?? "BOTH"}`;
      if (!a.confirm) return preview([sql], { impact: { current, container: await db.currentContainer() } });
      await db.exec(sql);
      const after = await db.one("SELECT name, display_value AS value FROM v$parameter WHERE name = :n", { n: name });
      return { executed: true, statement: sql, before: current, after };
    },
  },
  {
    name: "oracle_alert_log",
    description:
      "Returns the latest entries of the database alert log (V$DIAG_ALERT_EXT), oldest first. Use only_errors to see just ORA-/TNS- messages.",
    risk: "R",
    params: {
      last_n: { type: "number", description: "Number of entries (default 50, max 500)." },
      only_errors: { type: "boolean", description: "Only entries containing ORA- or TNS- errors (default false)." },
      since_minutes: { type: "number", description: "Only entries of the last N minutes." },
    },
    handler: async (a, { db }) => {
      const n = clamp(a.last_n, 50, 500);
      const since = a.since_minutes !== undefined && a.since_minutes > 0 ? a.since_minutes : null;
      const timeFilter = since === null ? "" : "AND originating_timestamp > SYSTIMESTAMP - NUMTODSINTERVAL(:mins, 'MINUTE')";
      const binds: Record<string, unknown> = { e: a.only_errors ? 1 : 0, n };
      if (since !== null) binds.mins = since;
      const res = await db.list(
        `SELECT * FROM (
           SELECT originating_timestamp AS time, message_level, RTRIM(message_text, CHR(10)) AS message
             FROM v$diag_alert_ext
            WHERE component_id = 'rdbms' ${timeFilter}
              AND (:e = 0 OR message_text LIKE '%ORA-%' OR message_text LIKE '%TNS-%')
            ORDER BY originating_timestamp DESC, record_id DESC)
          WHERE ROWNUM <= :n`,
        binds,
        n
      );
      return { rowCount: res.rowCount, entries: res.rows.reverse() };
    },
  },
  {
    name: "oracle_pdb_state",
    description:
      "Opens or closes a pluggable database, or saves its current state so it reopens automatically after an instance restart (SAVE_STATE). Run from CDB$ROOT (oracle_switch_container). CLOSE needs confirm=true and disconnects all sessions of that PDB.",
    risk: "D",
    params: {
      pdb: { type: "string", description: "PDB name, e.g. XEPDB1.", required: true },
      action: { type: "string", description: "OPEN, CLOSE or SAVE_STATE.", required: true, enum: ["OPEN", "CLOSE", "SAVE_STATE"] },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const pdb = plainName(a.pdb, "PDB name");
      const current = await db.currentContainer();
      const state = (): Promise<unknown> =>
        db.one("SELECT name, open_mode, restricted FROM v$containers WHERE name = :p", { p: pdb });
      const before = await state();
      if (!before) {
        throw new ToolError(
          `PDB ${pdb} is not visible from container ${current}. Switch to CDB$ROOT with oracle_switch_container and check oracle_list_containers.`
        );
      }
      const sql =
        a.action === "OPEN"
          ? `ALTER PLUGGABLE DATABASE ${pdb} OPEN`
          : a.action === "CLOSE"
            ? `ALTER PLUGGABLE DATABASE ${pdb} CLOSE IMMEDIATE`
            : `ALTER PLUGGABLE DATABASE ${pdb} SAVE STATE`;
      if (a.action === "CLOSE") {
        const sessions = await db.scalar<number>(
          "SELECT COUNT(*) AS c FROM v$session s JOIN v$containers c ON c.con_id = s.con_id WHERE c.name = :p AND s.type = 'USER'",
          { p: pdb }
        );
        if (!a.confirm) {
          return preview([sql], {
            impact: { before, userSessions: sessions },
            warning:
              current === pdb
                ? "The MCP session itself is connected to this PDB and will be disconnected. Switch to CDB$ROOT first; note that the configured service only works again once the PDB is open."
                : undefined,
          });
        }
      }
      await db.exec(sql);
      let after: unknown = null;
      try {
        after = await state();
      } catch {
        after = { note: "State could not be read; the session was probably connected to the closed PDB." };
      }
      return { executed: true, statement: sql, before, after };
    },
  },
];
