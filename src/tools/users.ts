/** D. Users and privileges. */

import { CONFIRM, preview, type ToolDef } from "../registry.js";
import { dictName, q, sizeClause, ToolError } from "../util.js";

function passwordClause(pw: string): string {
  if (pw.includes('"') || pw.includes("\0") || pw.length === 0 || pw.length > 1024) {
    throw new ToolError("Password must not be empty or contain a double quote.");
  }
  return `"${pw}"`;
}

function mask(sql: string): string {
  return sql.replace(/IDENTIFIED BY "[^"]*"/g, 'IDENTIFIED BY "********"');
}

/** System privilege or role name, e.g. CREATE SESSION, DBA, SELECT ANY TABLE. */
function privilegeName(input: string): string {
  const s = String(input).trim().toUpperCase().replace(/\s+/g, " ");
  if (!/^[A-Z][A-Z0-9_$# ]*$/.test(s) || s.length > 128) throw new ToolError(`Invalid privilege or role: "${input}"`);
  return s;
}

function quotaClause(input: string): string {
  return String(input).trim().toUpperCase() === "UNLIMITED" ? "UNLIMITED" : sizeClause(input, "quota");
}

function grantee(input: string): string {
  return String(input).trim().toUpperCase() === "PUBLIC" ? "PUBLIC" : q(input, "grantee");
}

export const userTools: ToolDef[] = [
  {
    name: "oracle_list_users",
    description:
      "Lists database users with account status, profile, tablespaces, password expiry and last login. Oracle-maintained users are hidden by default.",
    risk: "R",
    params: {
      include_oracle_maintained: { type: "boolean", description: "Also list Oracle-maintained users (default false)." },
    },
    handler: async (a, { db }) =>
      (await db.dict()) === "all"
        ? db.list(
            `SELECT username, created, common, oracle_maintained FROM all_users
              WHERE (:inc = 1 OR oracle_maintained = 'N') ORDER BY oracle_maintained, username`,
            { inc: a.include_oracle_maintained ? 1 : 0 }
          )
        : db.list(
        `SELECT username, account_status, profile, default_tablespace, temporary_tablespace, created,
                expiry_date, lock_date, last_login, authentication_type, common, oracle_maintained
           FROM dba_users
          WHERE (:inc = 1 OR oracle_maintained = 'N')
          ORDER BY oracle_maintained, username`,
        { inc: a.include_oracle_maintained ? 1 : 0 }
      ),
  },
  {
    name: "oracle_create_user",
    description:
      "Creates a database user (schema) in the current container and optionally grants roles/privileges. In a PDB this creates a local user; in CDB$ROOT user names must start with C##.",
    risk: "W",
    params: {
      username: { type: "string", description: "New user name.", required: true },
      password: { type: "string", description: "Password for the new user.", required: true },
      default_tablespace: { type: "string", description: "Default tablespace (default: database default, usually USERS)." },
      quota: { type: "string", description: "Quota on the default tablespace: UNLIMITED or a size like 500M." },
      roles: {
        type: "string[]",
        description: "Roles or system privileges to grant, e.g. [\"CONNECT\",\"RESOURCE\"] or [\"CREATE SESSION\",\"CREATE TABLE\"].",
      },
    },
    handler: async (a, { db }) => {
      const user = q(a.username, "username");
      let ts: string | null = a.default_tablespace ? dictName(a.default_tablespace, "tablespace") : null;
      let sql = `CREATE USER ${user} IDENTIFIED BY ${passwordClause(a.password)}`;
      if (ts) sql += ` DEFAULT TABLESPACE "${ts}"`;
      if (a.quota) {
        if (!ts) {
          ts = await db.scalar<string>(
            "SELECT property_value FROM database_properties WHERE property_name = 'DEFAULT_PERMANENT_TABLESPACE'"
          );
        }
        if (!ts) throw new ToolError("Cannot determine the default tablespace for the quota; pass default_tablespace.");
        sql += ` QUOTA ${quotaClause(a.quota)} ON "${ts}"`;
      }
      const statements = [sql];
      if (a.roles?.length) {
        statements.push(`GRANT ${(a.roles as string[]).map(privilegeName).join(", ")} TO ${user}`);
      }
      const done: string[] = [];
      for (const s of statements) {
        try {
          await db.exec(s);
        } catch (e) {
          (e as { sql?: string }).sql = mask(s);
          if (done.length) (e as Error).message += ` (user was created, but the GRANT failed)`;
          throw e;
        }
        done.push(mask(s));
      }
      return { created: dictName(a.username), container: await db.currentContainer(), statements: done };
    },
  },
  {
    name: "oracle_alter_user",
    description: "Changes a user: new password, lock/unlock the account, default tablespace, tablespace quota.",
    risk: "W",
    params: {
      username: { type: "string", description: "User to change.", required: true },
      new_password: { type: "string", description: "New password." },
      lock: { type: "boolean", description: "true = ACCOUNT LOCK, false = ACCOUNT UNLOCK." },
      default_tablespace: { type: "string", description: "New default tablespace." },
      quota: { type: "string", description: "Quota (UNLIMITED or e.g. 500M) on default_tablespace, or on the user's current default tablespace." },
    },
    handler: async (a, { db }) => {
      const name = dictName(a.username, "username");
      const row = await db.one("SELECT default_tablespace FROM dba_users WHERE username = :u", { u: name });
      if (!row) throw new ToolError(`User ${name} does not exist in container ${await db.currentContainer()}.`);
      const clauses: string[] = [];
      if (a.new_password !== undefined) clauses.push(`IDENTIFIED BY ${passwordClause(a.new_password)}`);
      const ts = a.default_tablespace ? dictName(a.default_tablespace, "tablespace") : String(row.default_tablespace);
      if (a.default_tablespace) clauses.push(`DEFAULT TABLESPACE "${ts}"`);
      if (a.quota) clauses.push(`QUOTA ${quotaClause(a.quota)} ON "${ts}"`);
      if (a.lock !== undefined) clauses.push(a.lock ? "ACCOUNT LOCK" : "ACCOUNT UNLOCK");
      if (clauses.length === 0) throw new ToolError("Nothing to change: pass new_password, lock, default_tablespace or quota.");
      const sql = `ALTER USER ${q(a.username, "username")} ${clauses.join(" ")}`;
      try {
        await db.exec(sql);
      } catch (e) {
        (e as { sql?: string }).sql = mask(sql);
        throw e;
      }
      const after = await db.one(
        "SELECT username, account_status, default_tablespace, expiry_date FROM dba_users WHERE username = :u",
        { u: name }
      );
      return { altered: name, statement: mask(sql), user: after };
    },
  },
  {
    name: "oracle_drop_user",
    description:
      "Drops a user. With cascade=true all objects of the schema are dropped too. The preview shows object count, size and connected sessions. Oracle-maintained users are blocked.",
    risk: "D",
    params: {
      username: { type: "string", description: "User to drop.", required: true },
      cascade: { type: "boolean", description: "Drop all objects of the user as well (default false; required if the schema has objects)." },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const name = dictName(a.username, "username");
      await db.assertUserSchema(name, "DROP USER");
      const me = await db.scalar<string>("SELECT SYS_CONTEXT('USERENV','SESSION_USER') AS u FROM dual");
      if (me === name) throw new ToolError("Cannot drop the user of the current session.");
      const impact = await db.one(
        `SELECT (SELECT COUNT(*) FROM dba_objects WHERE owner = :u) AS object_count,
                (SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) FROM dba_segments WHERE owner = :u) AS size_mb,
                (SELECT COUNT(*) FROM v$session WHERE username = :u) AS connected_sessions
           FROM dual`,
        { u: name }
      );
      const sql = `DROP USER ${q(a.username, "username")}${a.cascade ? " CASCADE" : ""}`;
      if (!a.confirm) {
        return preview([sql], {
          impact,
          warning:
            impact && impact.connected_sessions > 0
              ? "The user has connected sessions; DROP USER fails until they are gone (oracle_list_sessions / oracle_kill_session)."
              : undefined,
        });
      }
      await db.exec(sql);
      return { executed: true, dropped: name, statement: sql, freed: impact };
    },
  },
  {
    name: "oracle_list_privileges",
    description:
      "Shows what a user or role may do: directly granted system privileges, roles (resolved recursively), object privileges and tablespace quotas.",
    risk: "R",
    params: { grantee: { type: "string", description: "User or role name.", required: true } },
    handler: async (a, { db, config }) => {
      const g = String(a.grantee).trim().toUpperCase() === "PUBLIC" ? "PUBLIC" : dictName(a.grantee, "grantee");
      const b = { g };
      if ((await db.dict()) === "all") {
        const me = await db.scalar<string>("SELECT USER AS u FROM dual");
        if (g !== me) {
          throw new ToolError(`Without DBA dictionary access only the privileges of the connected user (${me}) can be shown.`);
        }
        const objPrivs = await db.list(
          `SELECT owner, table_name AS object_name, type AS object_type, privilege, grantable
             FROM user_tab_privs_recd ORDER BY owner, table_name, privilege`,
          {},
          config.maxRows
        );
        return {
          grantee: g,
          systemPrivileges: await db.rows("SELECT privilege, admin_option FROM user_sys_privs ORDER BY privilege"),
          roles: await db.rows("SELECT granted_role, admin_option, default_role FROM user_role_privs ORDER BY granted_role"),
          activeRoles: (await db.rows("SELECT role FROM session_roles ORDER BY role")).map((r) => r.role),
          objectPrivileges: objPrivs.rows,
          objectPrivilegesTruncated: objPrivs.truncated,
          quotas: await db.rows(
            `SELECT tablespace_name, ROUND(bytes/1048576, 1) AS used_mb,
                    CASE WHEN max_bytes = -1 THEN 'UNLIMITED' ELSE TO_CHAR(ROUND(max_bytes/1048576, 1)) END AS max_mb
               FROM user_ts_quotas`
          ),
        };
      }
      const systemPrivileges = await db.rows(
        "SELECT privilege, admin_option FROM dba_sys_privs WHERE grantee = :g ORDER BY privilege",
        b
      );
      const roles = await db.rows(
        `SELECT DISTINCT grantee AS granted_to, granted_role, admin_option, default_role
           FROM dba_role_privs
          START WITH grantee = :g
        CONNECT BY NOCYCLE PRIOR granted_role = grantee
          ORDER BY 1, 2`,
        b
      );
      const objectPrivileges = await db.list(
        `SELECT owner, table_name AS object_name, type AS object_type, privilege, grantable
           FROM dba_tab_privs WHERE grantee = :g ORDER BY owner, table_name, privilege`,
        b,
        config.maxRows
      );
      const quotas = await db.rows(
        `SELECT tablespace_name, ROUND(bytes/1048576, 1) AS used_mb,
                CASE WHEN max_bytes = -1 THEN 'UNLIMITED' ELSE TO_CHAR(ROUND(max_bytes/1048576, 1)) END AS max_mb
           FROM dba_ts_quotas WHERE username = :g`,
        b
      );
      if (!systemPrivileges.length && !roles.length && !objectPrivileges.rowCount && !quotas.length) {
        const exists = await db.one(
          "SELECT 1 AS x FROM dba_users WHERE username = :g UNION ALL SELECT 1 FROM dba_roles WHERE role = :g",
          b
        );
        if (!exists && g !== "PUBLIC") throw new ToolError(`No user or role named ${g} in container ${await db.currentContainer()}.`);
      }
      return {
        grantee: g,
        systemPrivileges,
        roles,
        objectPrivileges: objectPrivileges.rows,
        objectPrivilegesTruncated: objectPrivileges.truncated,
        quotas,
      };
    },
  },
  {
    name: "oracle_grant_revoke",
    description:
      "Grants or revokes system privileges, roles or object privileges. For object privileges pass on_object as SCHEMA.OBJECT (e.g. privileges [\"SELECT\",\"INSERT\"] on HR.EMPLOYEES).",
    risk: "W",
    params: {
      action: { type: "string", description: "GRANT or REVOKE.", required: true, enum: ["GRANT", "REVOKE"] },
      privileges: {
        type: "string[]",
        description: "Privileges or roles, e.g. [\"CREATE SESSION\"], [\"DBA\"] or [\"SELECT\",\"UPDATE\"].",
        required: true,
      },
      grantee: { type: "string", description: "User or role receiving / losing the privileges (or PUBLIC).", required: true },
      on_object: { type: "string", description: "SCHEMA.OBJECT for object privileges. Omit for system privileges and roles." },
      with_admin_option: {
        type: "boolean",
        description: "GRANT only: WITH ADMIN OPTION (system privileges/roles) or WITH GRANT OPTION (object privileges).",
      },
    },
    handler: async (a, { db }) => {
      const privs = (a.privileges as string[]).map(privilegeName).join(", ");
      let target = "";
      if (a.on_object) {
        const parts = String(a.on_object).match(/"[^"]+"|[^.]+/g) ?? [];
        if (parts.length !== 2) throw new ToolError("on_object must be SCHEMA.OBJECT.");
        target = ` ON ${q(parts[0], "schema")}.${q(parts[1], "object name")}`;
      }
      const who = grantee(a.grantee);
      let sql: string;
      if (a.action === "GRANT") {
        sql = `GRANT ${privs}${target} TO ${who}`;
        if (a.with_admin_option) sql += a.on_object ? " WITH GRANT OPTION" : " WITH ADMIN OPTION";
      } else {
        sql = `REVOKE ${privs}${target} FROM ${who}`;
      }
      await db.exec(sql);
      return { executed: true, statement: sql };
    },
  },
];
