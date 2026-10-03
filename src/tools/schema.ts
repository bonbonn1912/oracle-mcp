/** C. Schema and object discovery tools. */

import { clamp, type ToolDef } from "../registry.js";
import { dictName, likePattern, ToolError } from "../util.js";

const userSchemas = (d: string): string => `(SELECT username FROM ${d}_users WHERE oracle_maintained = 'N')`;

function columnType(c: Record<string, any>): string {
  const t = String(c.data_type);
  if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR)$/.test(t)) {
    const unit = /^N/.test(t) ? "" : c.char_used === "C" ? " CHAR" : " BYTE";
    return `${t}(${c.char_length}${unit})`;
  }
  if (t === "NUMBER") {
    if (c.data_precision == null) return c.data_scale == null || c.data_scale === 0 ? "NUMBER" : `NUMBER(*,${c.data_scale})`;
    return c.data_scale ? `NUMBER(${c.data_precision},${c.data_scale})` : `NUMBER(${c.data_precision})`;
  }
  if (t === "FLOAT" && c.data_precision != null) return `FLOAT(${c.data_precision})`;
  if (t === "RAW") return `RAW(${c.data_length})`;
  return t;
}

const DDL_TYPE_MAP: Record<string, string> = {
  "PACKAGE BODY": "PACKAGE_BODY",
  "PACKAGE SPEC": "PACKAGE_SPEC",
  "TYPE BODY": "TYPE_BODY",
  "TYPE SPEC": "TYPE_SPEC",
  "MATERIALIZED VIEW": "MATERIALIZED_VIEW",
  "MATERIALIZED VIEW LOG": "MATERIALIZED_VIEW_LOG",
  "DATABASE LINK": "DB_LINK",
  JOB: "PROCOBJ",
  "JAVA SOURCE": "JAVA_SOURCE",
};
const SCHEMALESS_DDL = new Set(["USER", "ROLE", "TABLESPACE", "PROFILE", "DIRECTORY"]);

export const schemaTools: ToolDef[] = [
  {
    name: "oracle_list_schemas",
    description:
      "Lists schemas (database users) with account status, default tablespace, object count and size in MB. By default Oracle-maintained schemas (SYS, SYSTEM, XDB...) are hidden.",
    risk: "R",
    params: {
      include_oracle_maintained: { type: "boolean", description: "Also list Oracle-maintained schemas (default false)." },
      name_like: { type: "string", description: "Filter on the schema name, e.g. HR or APP%. Case-insensitive." },
    },
    handler: async (a, { db }) => {
      const d = await db.dict();
      if (d === "all") {
        // ordinary user: only schemas in which the user can see at least one object, plus the own schema
        const visible = await db.list(
          `SELECT u.username, u.created, u.oracle_maintained, NVL(o.object_count, 0) AS visible_objects
             FROM all_users u
             LEFT JOIN (SELECT owner, COUNT(*) AS object_count FROM all_objects GROUP BY owner) o ON o.owner = u.username
            WHERE (:inc = 1 OR u.oracle_maintained = 'N')
              AND (:pat IS NULL OR UPPER(u.username) LIKE UPPER(:pat))
              AND (NVL(o.object_count, 0) > 0 OR u.username = USER)
            ORDER BY CASE WHEN u.username = USER THEN 0 ELSE 1 END, u.username`,
          { inc: a.include_oracle_maintained ? 1 : 0, pat: likePattern(a.name_like) }
        );
        return {
          container: await db.currentContainer(),
          note: "Limited view: only schemas with objects visible to the connected user; sizes need DBA dictionary access.",
          ...visible,
        };
      }
      const res = await db.list(
        `SELECT u.username, u.account_status, u.default_tablespace, u.temporary_tablespace, u.created,
                u.oracle_maintained, NVL(o.object_count, 0) AS object_count, NVL(s.size_mb, 0) AS size_mb
           FROM ${d}_users u
           LEFT JOIN (SELECT owner, COUNT(*) AS object_count FROM ${d}_objects GROUP BY owner) o ON o.owner = u.username
           LEFT JOIN (SELECT owner, ROUND(SUM(bytes)/1048576, 1) AS size_mb FROM ${d}_segments GROUP BY owner) s ON s.owner = u.username
          WHERE (:inc = 1 OR u.oracle_maintained = 'N')
            AND (:pat IS NULL OR UPPER(u.username) LIKE UPPER(:pat))
          ORDER BY u.oracle_maintained, u.username`,
        { inc: a.include_oracle_maintained ? 1 : 0, pat: likePattern(a.name_like) }
      );
      return { container: await db.currentContainer(), ...res };
    },
  },
  {
    name: "oracle_list_objects",
    description:
      "Lists the objects of one schema (tables, views, indexes, sequences, packages, procedures, triggers...) with status and last DDL time. Filter by type and name.",
    risk: "R",
    params: {
      schema: { type: "string", description: "Schema name.", required: true },
      object_types: {
        type: "string[]",
        description: "Object types to include, e.g. [\"TABLE\",\"VIEW\",\"PACKAGE\"]. Default: all types.",
      },
      name_like: { type: "string", description: "Filter on the object name (case-insensitive, % wildcard)." },
      max_rows: { type: "number", description: "Maximum rows (default ORACLE_MAX_ROWS)." },
    },
    handler: async (a, { db, config }) => {
      const d = await db.dict();
      const schema = dictName(a.schema, "schema");
      const binds: Record<string, unknown> = { o: schema, pat: likePattern(a.name_like) };
      let typeFilter = "";
      if (a.object_types?.length) {
        const names = (a.object_types as string[]).map((t, i) => {
          binds[`t${i}`] = t.toUpperCase().replace(/_/g, " ");
          return `:t${i}`;
        });
        typeFilter = `AND object_type IN (${names.join(", ")})`;
      }
      const res = await db.list(
        `SELECT object_name, object_type, status, created, last_ddl_time, temporary
           FROM ${d}_objects
          WHERE owner = :o AND (:pat IS NULL OR UPPER(object_name) LIKE UPPER(:pat)) ${typeFilter}
          ORDER BY object_type, object_name`,
        binds,
        clamp(a.max_rows, config.maxRows, config.maxRows)
      );
      const counts = await db.rows(
        `SELECT object_type, COUNT(*) AS cnt FROM ${d}_objects WHERE owner = :o GROUP BY object_type ORDER BY object_type`,
        { o: schema }
      );
      if (counts.length === 0) {
        const exists = await db.one(`SELECT 1 AS x FROM ${d}_users WHERE username = :o`, { o: schema });
        if (!exists) throw new ToolError(`Schema ${schema} does not exist in container ${await db.currentContainer()}.`);
      }
      return { schema, totalsByType: Object.fromEntries(counts.map((c) => [c.object_type, c.cnt])), ...res };
    },
  },
  {
    name: "oracle_describe_table",
    description:
      "Describes a table or view: columns with data types, nullability, defaults and comments, primary/foreign/unique/check constraints, indexes, partition count, row count from statistics and size in MB.",
    risk: "R",
    params: {
      schema: { type: "string", description: "Schema name.", required: true },
      table: { type: "string", description: "Table, view or materialized view name.", required: true },
    },
    handler: async (a, { db }) => {
      const d = await db.dict();
      const o = dictName(a.schema, "schema");
      const t = dictName(a.table, "table");
      const b = { o, t };
      const obj = await db.rows(
        `SELECT object_type, status, created, last_ddl_time FROM ${d}_objects
          WHERE owner = :o AND object_name = :t AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW')`,
        b
      );
      if (obj.length === 0) throw new ToolError(`No table or view ${o}.${t} found. Check with oracle_list_objects.`);
      const objectType = obj.some((x) => x.object_type === "MATERIALIZED VIEW")
        ? "MATERIALIZED VIEW"
        : String(obj[0].object_type);

      const cols = await db.rows(
        `SELECT c.column_id, c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale,
                c.char_length, c.char_used, c.nullable, c.data_default, c.virtual_column, c.identity_column,
                m.comments
           FROM ${d}_tab_cols c
           LEFT JOIN ${d}_col_comments m
             ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
          WHERE c.owner = :o AND c.table_name = :t AND c.hidden_column = 'NO'
          ORDER BY c.column_id`,
        b
      );
      const columns = cols.map((c) => {
        const out: Record<string, unknown> = {
          name: c.column_name,
          type: columnType(c),
          nullable: c.nullable === "Y",
        };
        if (c.data_default != null) out.default = String(c.data_default).trim();
        if (c.virtual_column === "YES") out.virtual = true;
        if (c.identity_column === "YES") out.identity = true;
        if (c.comments) out.comment = c.comments;
        return out;
      });

      const info = await db.one(
        `SELECT tablespace_name, num_rows, blocks, avg_row_len, last_analyzed, partitioned, temporary,
                compression, row_movement, iot_type
           FROM ${d}_tables WHERE owner = :o AND table_name = :t`,
        b
      );
      const comment = await db.scalar<string>(
        `SELECT comments FROM ${d}_tab_comments WHERE owner = :o AND table_name = :t AND ROWNUM = 1`,
        b
      );
      const constraints = await db.rows(
        `SELECT c.constraint_name, c.constraint_type, c.status, c.validated, c.search_condition_vc AS condition,
                c.delete_rule, c.r_owner, c.r_constraint_name,
                (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
                   FROM ${d}_cons_columns cc
                  WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name AND cc.table_name = c.table_name) AS column_names,
                (SELECT r.table_name FROM ${d}_constraints r
                  WHERE r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name) AS r_table,
                (SELECT LISTAGG(rc.column_name, ', ') WITHIN GROUP (ORDER BY rc.position)
                   FROM ${d}_cons_columns rc
                  WHERE rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name) AS r_columns
           FROM ${d}_constraints c
          WHERE c.owner = :o AND c.table_name = :t
          ORDER BY c.constraint_type, c.constraint_name`,
        b
      );
      const typeName: Record<string, string> = { P: "PRIMARY KEY", R: "FOREIGN KEY", U: "UNIQUE", C: "CHECK" };
      const cons = constraints
        // NOT NULL checks are already visible as nullable=false on the column
        .filter((c) => !(c.constraint_type === "C" && /^"[^"]+" IS NOT NULL$/.test(String(c.condition ?? ""))))
        .map((c) => {
          const out: Record<string, unknown> = {
            name: c.constraint_name,
            type: typeName[c.constraint_type] ?? c.constraint_type,
            columns: c.column_names,
            status: c.status,
          };
          if (c.constraint_type === "C") out.condition = c.condition;
          if (c.constraint_type === "R") {
            out.references = `${c.r_owner}.${c.r_table}(${c.r_columns})`;
            out.onDelete = c.delete_rule;
          }
          return out;
        });

      const indexes = await db.rows(
        `SELECT i.owner, i.index_name, i.index_type, i.uniqueness, i.status, i.tablespace_name, i.partitioned,
                (SELECT LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position)
                   FROM ${d}_ind_columns ic
                  WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name) AS column_names
           FROM ${d}_indexes i
          WHERE i.table_owner = :o AND i.table_name = :t
          ORDER BY i.index_name`,
        b
      );
      const sizes = d !== "dba" ? null : await db.one(
        `SELECT ROUND(NVL(SUM(CASE WHEN kind = 'T' THEN bytes END), 0)/1048576, 2) AS table_mb,
                ROUND(NVL(SUM(CASE WHEN kind = 'I' THEN bytes END), 0)/1048576, 2) AS index_mb,
                ROUND(NVL(SUM(CASE WHEN kind = 'L' THEN bytes END), 0)/1048576, 2) AS lob_mb
           FROM (
             SELECT 'T' AS kind, s.bytes FROM ${d}_segments s
              WHERE s.owner = :o AND s.segment_name = :t AND s.segment_type LIKE 'TABLE%'
             UNION ALL
             SELECT 'I', s.bytes FROM ${d}_segments s
               JOIN ${d}_indexes i ON i.owner = s.owner AND i.index_name = s.segment_name
              WHERE i.table_owner = :o AND i.table_name = :t AND s.segment_type LIKE 'INDEX%'
             UNION ALL
             SELECT 'L', s.bytes FROM ${d}_segments s
               JOIN ${d}_lobs l ON l.owner = s.owner AND (l.segment_name = s.segment_name OR l.index_name = s.segment_name)
              WHERE l.owner = :o AND l.table_name = :t AND s.segment_type LIKE 'LOB%'
           )`,
        b
      );
      const partitions = await db.scalar<number>(
        `SELECT COUNT(*) AS c FROM ${d}_tab_partitions WHERE table_owner = :o AND table_name = :t`,
        b
      );
      return {
        schema: o,
        name: t,
        objectType,
        status: obj[0].status,
        comment: comment ?? null,
        table: info ?? null,
        partitionCount: partitions ?? 0,
        sizeMb: sizes,
        columns,
        constraints: cons,
        indexes,
      };
    },
  },
  {
    name: "oracle_get_ddl",
    description:
      "Returns the CREATE statement of an object via DBMS_METADATA.GET_DDL. Works for TABLE, VIEW, INDEX, SEQUENCE, PACKAGE, PACKAGE BODY, PROCEDURE, FUNCTION, TRIGGER, TYPE, SYNONYM, MATERIALIZED VIEW and also USER, ROLE, TABLESPACE (schema is ignored for those).",
    risk: "R",
    params: {
      schema: { type: "string", description: "Owner of the object.", required: true },
      object_name: { type: "string", description: "Object name.", required: true },
      object_type: { type: "string", description: "Object type, e.g. TABLE, VIEW, PACKAGE BODY, USER.", required: true },
      include_storage: { type: "boolean", description: "Include storage, tablespace and segment clauses (default false)." },
    },
    handler: async (a, { db }) => {
      const d = await db.dict();
      const rawType = String(a.object_type).trim().toUpperCase().replace(/\s+/g, " ");
      if (!/^[A-Z][A-Z _]*$/.test(rawType)) throw new ToolError(`Invalid object_type: ${a.object_type}`);
      const type = DDL_TYPE_MAP[rawType] ?? rawType.replace(/ /g, "_");
      const name = dictName(a.object_name, "object name");
      const flag = a.include_storage ? "TRUE" : "FALSE";
      await db.exec(
        `BEGIN
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE);
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', ${flag});
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', ${flag});
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'TABLESPACE', ${flag});
         END;`,
        {},
        false
      );
      const res = SCHEMALESS_DDL.has(type)
        ? await db.exec("SELECT DBMS_METADATA.GET_DDL(:t, :n) FROM dual", { t: type, n: name }, false)
        : await db.exec(
            "SELECT DBMS_METADATA.GET_DDL(:t, :n, :s) FROM dual",
            { t: type, n: name, s: dictName(a.schema, "schema") },
            false
          );
      const ddl = String((res.rows as unknown[][])?.[0]?.[0] ?? "").trim();
      return { object: SCHEMALESS_DDL.has(type) ? name : `${dictName(a.schema, "schema")}.${name}`, type: rawType, ddl };
    },
  },
  {
    name: "oracle_search_source",
    description:
      "Searches the data dictionary: object names (NAMES), column names (COLUMNS) or text inside PL/SQL source code (SOURCE). Without schema only non-Oracle schemas are searched.",
    risk: "R",
    params: {
      pattern: { type: "string", description: "Search text, case-insensitive. % can be used as wildcard.", required: true },
      schema: { type: "string", description: "Restrict the search to one schema." },
      search_in: { type: "string", description: "Where to search (default NAMES).", enum: ["NAMES", "SOURCE", "COLUMNS"] },
      max_rows: { type: "number", description: "Maximum rows (default ORACLE_MAX_ROWS)." },
    },
    handler: async (a, { db, config }) => {
      const d = await db.dict();
      const pat = likePattern(a.pattern);
      const schema = a.schema ? dictName(a.schema, "schema") : null;
      const max = clamp(a.max_rows, config.maxRows, config.maxRows);
      const binds = { pat, s: schema };
      const where = (col: string): string => `(:s IS NOT NULL AND ${col} = :s OR :s IS NULL AND ${col} IN ${userSchemas(d)})`;
      const mode = a.search_in ?? "NAMES";
      if (mode === "NAMES") {
        return db.list(
          `SELECT owner, object_name, object_type, status, last_ddl_time FROM ${d}_objects
            WHERE UPPER(object_name) LIKE UPPER(:pat) AND ${where("owner")}
            ORDER BY owner, object_type, object_name`,
          binds,
          max
        );
      }
      if (mode === "COLUMNS") {
        return db.list(
          `SELECT owner, table_name, column_name, data_type FROM ${d}_tab_columns
            WHERE UPPER(column_name) LIKE UPPER(:pat) AND ${where("owner")}
            ORDER BY owner, table_name, column_id`,
          binds,
          max
        );
      }
      return db.list(
        `SELECT owner, name, type, line, RTRIM(SUBSTR(text, 1, 400), CHR(10)) AS text FROM ${d}_source
          WHERE UPPER(text) LIKE UPPER(:pat) AND ${where("owner")}
          ORDER BY owner, name, type, line`,
        binds,
        max
      );
    },
  },
  {
    name: "oracle_get_dependencies",
    description:
      "Shows dependencies of an object from DBA_DEPENDENCIES: what it uses (USES) or what depends on it (USED_BY). For tables it also lists foreign-key relations in that direction.",
    risk: "R",
    params: {
      schema: { type: "string", description: "Owner of the object.", required: true },
      object_name: { type: "string", description: "Object name.", required: true },
      direction: { type: "string", description: "USES = objects this one references, USED_BY = objects referencing this one (default USED_BY).", enum: ["USES", "USED_BY"] },
    },
    handler: async (a, { db, config }) => {
      const d = await db.dict();
      const o = dictName(a.schema, "schema");
      const n = dictName(a.object_name, "object name");
      const dir = a.direction ?? "USED_BY";
      const b = { o, n };
      const deps =
        dir === "USES"
          ? await db.list(
              `SELECT type AS object_type, referenced_owner, referenced_name, referenced_type, referenced_link_name
                 FROM ${d}_dependencies WHERE owner = :o AND name = :n
                ORDER BY referenced_owner, referenced_name`,
              b,
              config.maxRows
            )
          : await db.list(
              `SELECT owner, name, type, dependency_type FROM ${d}_dependencies
                WHERE referenced_owner = :o AND referenced_name = :n
                ORDER BY owner, name`,
              b,
              config.maxRows
            );
      const fks =
        dir === "USES"
          ? await db.rows(
              `SELECT c.constraint_name, r.owner AS parent_owner, r.table_name AS parent_table, c.delete_rule, c.status
                 FROM ${d}_constraints c
                 JOIN ${d}_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
                WHERE c.constraint_type = 'R' AND c.owner = :o AND c.table_name = :n
                ORDER BY r.owner, r.table_name`,
              b
            )
          : await db.rows(
              `SELECT c.owner AS child_owner, c.table_name AS child_table, c.constraint_name, c.delete_rule, c.status
                 FROM ${d}_constraints c
                 JOIN ${d}_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
                WHERE c.constraint_type = 'R' AND r.owner = :o AND r.table_name = :n
                ORDER BY c.owner, c.table_name`,
              b
            );
      return { object: `${o}.${n}`, direction: dir, dependencies: deps.rows, dependenciesTruncated: deps.truncated, foreignKeys: fks };
    },
  },
  {
    name: "oracle_list_invalid_objects",
    description: "Lists invalid objects (status INVALID) with their compilation errors from DBA_ERRORS.",
    risk: "R",
    params: { schema: { type: "string", description: "Restrict to one schema (default: all schemas)." } },
    handler: async (a, { db, config }) => {
      const d = await db.dict();
      const s = a.schema ? dictName(a.schema, "schema") : null;
      return db.list(
        `SELECT o.owner, o.object_name, o.object_type, o.last_ddl_time,
                (SELECT LISTAGG('line ' || e.line || ': ' || RTRIM(e.text, CHR(10)), ' | ' ON OVERFLOW TRUNCATE)
                          WITHIN GROUP (ORDER BY e.sequence)
                   FROM ${d}_errors e
                  WHERE e.owner = o.owner AND e.name = o.object_name AND e.type = o.object_type
                    AND e.attribute = 'ERROR') AS errors
           FROM ${d}_objects o
          WHERE o.status = 'INVALID' AND (:s IS NULL OR o.owner = :s)
          ORDER BY o.owner, o.object_type, o.object_name`,
        { s },
        config.maxRows
      );
    },
  },
  {
    name: "oracle_compile_invalid",
    long: true,
    description:
      "Recompiles invalid objects: for one schema via DBMS_UTILITY.COMPILE_SCHEMA, for the whole database via UTL_RECOMP.RECOMP_SERIAL. Returns the invalid count before and after.",
    risk: "W",
    params: { schema: { type: "string", description: "Schema to recompile (default: whole database)." } },
    handler: async (a, { db }) => {
      const d = await db.dict();
      const s = a.schema ? dictName(a.schema, "schema") : null;
      const count = (): Promise<number | null> =>
        db.scalar<number>(`SELECT COUNT(*) AS c FROM ${d}_objects WHERE status = 'INVALID' AND (:s IS NULL OR owner = :s)`, { s });
      const before = await count();
      if (s) {
        await db.exec("BEGIN DBMS_UTILITY.COMPILE_SCHEMA(schema => :s, compile_all => FALSE); END;", { s });
      } else {
        await db.exec("BEGIN UTL_RECOMP.RECOMP_SERIAL(); END;");
      }
      const after = await count();
      return {
        scope: s ?? "DATABASE",
        invalidBefore: before,
        invalidAfter: after,
        hint: after ? "Use oracle_list_invalid_objects to see the remaining errors." : undefined,
      };
    },
  },
];
