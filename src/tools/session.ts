/** A. Connection and session tools. */

import type { ToolDef } from "../registry.js";
import { dictName, plainName, q, ToolError } from "../util.js";

function target(c: { user: string; connectString: string; privilege: string }): string {
  return `${c.user}@${c.connectString}${c.privilege ? ` as ${c.privilege}` : ""}`;
}

export const sessionTools: ToolDef[] = [
  {
    name: "oracle_list_connections",
    description:
      "Lists the configured database connections: the default \"local\" plus any servers. Shows which one is active, where each points to and whether it is read-only. Call this to find out which databases exist before choosing one.",
    risk: "R",
    noConnection: true,
    params: {},
    handler: async (_a, { connections }) => {
      const active = connections.active();
      return {
        active,
        connections: connections.list().map((c) => ({
          name: c.name,
          description: c.description || undefined,
          target: target(c),
          readOnly: c.readOnly,
          active: c.name === active,
          connected: connections.isOpen(c.name),
          passwordConfigured: c.password !== "",
        })),
        usage:
          "Tools run against the active connection. Switch it with oracle_use_connection, or pass the \"connection\" parameter to a single tool call.",
      };
    },
  },
  {
    name: "oracle_use_connection",
    description:
      "Makes another configured connection the active one for all following tool calls (e.g. switch from local to a server and back). Tests the connection first; on failure the active connection stays unchanged.",
    risk: "R",
    params: {
      connection: { type: "string", description: "Connection name from oracle_list_connections, e.g. local.", required: true },
    },
    handler: async (_a, { db, config, connections }) => {
      const previous = connections.active();
      // index.ts already routed this call to the requested connection; make sure it works
      const who = await db.one(
        "SELECT SYS_CONTEXT('USERENV','SESSION_USER') AS session_user, SYS_CONTEXT('USERENV','CON_NAME') AS container, SYS_CONTEXT('USERENV','DB_NAME') AS db_name FROM dual"
      );
      connections.setActive(config.name);
      return {
        active: config.name,
        previous,
        description: config.description || undefined,
        target: target(config),
        readOnly: config.readOnly,
        session: who,
      };
    },
  },
  {
    name: "oracle_connection_info",
    description:
      "Connection test. Returns database version and edition, instance, current container (CDB root or PDB), session user, privilege, CURRENT_SCHEMA and whether a transaction is open. Call this first.",
    risk: "R",
    params: {},
    handler: async (_a, { db, config }) => {
      const session = await db.one(
        `SELECT SYS_CONTEXT('USERENV','SESSION_USER')   AS session_user,
                SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS current_schema,
                SYS_CONTEXT('USERENV','CON_NAME')       AS container,
                SYS_CONTEXT('USERENV','CON_ID')         AS con_id,
                SYS_CONTEXT('USERENV','ISDBA')          AS is_dba,
                SYS_CONTEXT('USERENV','SID')            AS sid,
                SYS_CONTEXT('USERENV','DB_NAME')        AS db_name,
                SYS_CONTEXT('USERENV','SERVICE_NAME')   AS service_name,
                DBMS_TRANSACTION.LOCAL_TRANSACTION_ID   AS transaction_id
           FROM dual`
      );
      let instance: unknown = null;
      let database: unknown = null;
      let banner: unknown = null;
      try {
        instance = await db.one(
          `SELECT instance_name, host_name, version_full AS version, edition, status, startup_time FROM v$instance`
        );
        database = await db.one(`SELECT name, cdb, open_mode, log_mode, platform_name FROM v$database`);
        banner = await db.scalar(`SELECT banner_full FROM v$version WHERE ROWNUM = 1`);
      } catch (e) {
        instance = { note: `V$ views not accessible: ${(e as Error).message}` };
      }
      return {
        connected: true,
        connection: config.name,
        description: config.description || undefined,
        connectString: config.connectString,
        configuredUser: config.user,
        privilege: config.privilege || "NONE",
        readOnlyMode: config.readOnly,
        dictionaryViews: (await db.dict()) === "dba" ? "DBA_* (full view)" : "ALL_* (only what this user may see)",
        session: { ...session, transaction_open: session?.transaction_id != null },
        instance,
        database,
        banner,
      };
    },
  },
  {
    name: "oracle_list_containers",
    description:
      "Lists the CDB root and all pluggable databases (PDBs) with open mode, restricted flag and size. Inside a PDB only that PDB is visible; switch to CDB$ROOT to see all.",
    risk: "R",
    params: {},
    handler: async (_a, { db }) => {
      const res = await db.list(
        `SELECT con_id, name, open_mode, restricted, ROUND(total_size/1048576, 1) AS size_mb, open_time
           FROM v$containers ORDER BY con_id`
      );
      return { current: await db.currentContainer(), containers: res.rows };
    },
  },
  {
    name: "oracle_switch_container",
    description:
      "Switches the session to another container (ALTER SESSION SET CONTAINER), e.g. CDB$ROOT or XEPDB1. Stays in effect for all following tool calls. Requires that no transaction is open.",
    risk: "W",
    params: {
      container: { type: "string", description: "Container name, e.g. CDB$ROOT or XEPDB1.", required: true },
    },
    handler: async (a, { db }) => {
      const name = plainName(a.container, "container name");
      if (await db.transactionOpen()) {
        throw new ToolError("A transaction is open. Call oracle_commit or oracle_rollback before switching containers.");
      }
      const before = await db.currentContainer();
      await db.exec(`ALTER SESSION SET CONTAINER = ${name}`);
      return { previous: before, current: await db.currentContainer() };
    },
  },
  {
    name: "oracle_set_current_schema",
    description:
      "Sets CURRENT_SCHEMA for the session so that following statements can reference objects of that schema without a prefix. Privileges are unchanged.",
    risk: "W",
    params: { schema: { type: "string", description: "Schema name.", required: true } },
    handler: async (a, { db }) => {
      const schema = dictName(a.schema, "schema");
      const exists = await db.one(`SELECT username FROM ${await db.dict()}_users WHERE username = :u`, { u: schema });
      if (!exists) throw new ToolError(`Schema ${schema} does not exist in container ${await db.currentContainer()}.`);
      await db.exec(`ALTER SESSION SET CURRENT_SCHEMA = ${q(a.schema, "schema")}`);
      return { current_schema: schema };
    },
  },
  {
    name: "oracle_commit",
    description: "Commits the open transaction of the session (only relevant after statements run with autocommit=false).",
    risk: "W",
    params: {},
    handler: async (_a, { db }) => {
      const open = await db.transactionOpen();
      await db.commit();
      return { committed: true, hadOpenTransaction: open };
    },
  },
  {
    name: "oracle_rollback",
    description: "Rolls back the open transaction of the session (only relevant after statements run with autocommit=false).",
    risk: "W",
    params: {},
    handler: async (_a, { db }) => {
      const open = await db.transactionOpen();
      await db.rollback();
      return { rolledBack: true, hadOpenTransaction: open };
    },
  },
];
