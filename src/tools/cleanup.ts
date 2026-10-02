/** F. Cleanup and space reclamation. */

import type { Db, Row } from "../db.js";
import { describeError } from "../db.js";
import { CONFIRM, preview, type ToolDef } from "../registry.js";
import { dictName, likePattern, lit, mb, q, qn, sizeClause, sizeToBytes, ToolError } from "../util.js";
import { DATAFILE_SQL, part, recyclebinMb } from "./storage.js";

/** Bytes used by a table including its indexes and LOB segments. */
async function tableFootprint(db: Db, o: string, t: string): Promise<number> {
  const v = await db.scalar<number>(
    `SELECT NVL(SUM(bytes), 0) AS b FROM (
       SELECT s.bytes FROM dba_segments s
        WHERE s.owner = :o AND s.segment_name = :t AND s.segment_type LIKE 'TABLE%'
       UNION ALL
       SELECT s.bytes FROM dba_segments s
         JOIN dba_indexes i ON i.owner = s.owner AND i.index_name = s.segment_name
        WHERE i.table_owner = :o AND i.table_name = :t AND s.segment_type LIKE 'INDEX%'
       UNION ALL
       SELECT s.bytes FROM dba_segments s
         JOIN dba_lobs l ON l.owner = s.owner AND (l.segment_name = s.segment_name OR l.index_name = s.segment_name)
        WHERE l.owner = :o AND l.table_name = :t AND s.segment_type LIKE 'LOB%')`,
    { o, t }
  );
  return Number(v ?? 0);
}

async function segmentBytes(db: Db, o: string, n: string): Promise<number> {
  const v = await db.scalar<number>(
    "SELECT NVL(SUM(bytes), 0) AS b FROM dba_segments WHERE owner = :o AND segment_name = :n",
    { o, n }
  );
  return Number(v ?? 0);
}

async function requireTable(db: Db, o: string, t: string): Promise<Row> {
  const row = await db.one(
    "SELECT table_name, row_movement, num_rows, temporary, iot_type FROM dba_tables WHERE owner = :o AND table_name = :t",
    { o, t }
  );
  if (!row) throw new ToolError(`Table ${o}.${t} does not exist in container ${await db.currentContainer()}.`);
  return row;
}

async function requireTablespace(db: Db, ts: string): Promise<Row> {
  const row = await db.one(
    "SELECT tablespace_name, contents, bigfile, block_size, status FROM dba_tablespaces WHERE tablespace_name = :ts",
    { ts }
  );
  if (!row) throw new ToolError(`Tablespace ${ts} does not exist in container ${await db.currentContainer()}.`);
  return row;
}

/** Path for a new datafile next to the existing ones, or null when Oracle Managed Files is configured. */
async function newDatafilePath(db: Db, ts: string): Promise<string | null> {
  const omf = await db.scalar<string>("SELECT value FROM v$parameter WHERE name = 'db_create_file_dest'");
  if (omf) return null;
  const sample = await db.scalar<string>(
    `SELECT file_name FROM (
       SELECT file_name, CASE WHEN tablespace_name = :ts THEN 0 ELSE 1 END AS pref, file_id FROM dba_data_files
        ORDER BY pref, file_id) WHERE ROWNUM = 1`,
    { ts }
  );
  if (!sample) throw new ToolError("Cannot derive a datafile directory: no datafiles visible.");
  const dir = sample.replace(/[^/\\]+$/, "");
  const base = ts.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const existing = new Set(
    (await db.rows("SELECT LOWER(file_name) AS f FROM dba_data_files UNION ALL SELECT LOWER(file_name) FROM dba_temp_files")).map(
      (r) => String(r.f)
    )
  );
  for (let i = 1; i < 1000; i++) {
    const candidate = `${dir}${base}${String(i).padStart(2, "0")}.dbf`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  throw new ToolError("Could not find a free datafile name.");
}

function autoextendClause(maxSize: string | undefined): string {
  const max = maxSize === undefined || maxSize.trim().toUpperCase() === "UNLIMITED" ? "UNLIMITED" : sizeClause(maxSize, "max_size");
  return `AUTOEXTEND ON NEXT 64M MAXSIZE ${max}`;
}

interface StepResult {
  statement: string;
  success: boolean;
  error?: string;
}

/** Runs statements one by one and keeps going on errors. */
async function runAll(db: Db, statements: string[], ignore: RegExp | null = null): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (const s of statements) {
    try {
      await db.exec(s);
      out.push({ statement: s, success: true });
    } catch (e) {
      const info = describeError(e);
      if (ignore && ignore.test(info.error)) out.push({ statement: s, success: true });
      else out.push({ statement: s, success: false, error: info.message });
    }
  }
  return out;
}

const DROP_ORDER = [
  "MATERIALIZED VIEW",
  "VIEW",
  "TRIGGER",
  "PACKAGE",
  "PROCEDURE",
  "FUNCTION",
  "SYNONYM",
  "TABLE",
  "SEQUENCE",
  "TYPE",
  "INDEX",
] as const;

function dropStatement(type: string, owner: string, name: string, purge: boolean): string {
  const obj = `"${owner}"."${name}"`;
  switch (type) {
    case "TABLE":
      return `DROP TABLE ${obj} CASCADE CONSTRAINTS${purge ? " PURGE" : ""}`;
    case "TYPE":
      return `DROP TYPE ${obj} FORCE`;
    case "SYNONYM":
      return `DROP SYNONYM ${obj} FORCE`;
    default:
      return `DROP ${type} ${obj}`;
  }
}

export const cleanupTools: ToolDef[] = [
  {
    name: "oracle_purge_recyclebin",
    long: true,
    description:
      "Permanently removes dropped objects from the recycle bin to free space: the whole database (scope DBA), one schema (SCHEMA) or one tablespace (TABLESPACE). Purged objects cannot be restored with FLASHBACK.",
    risk: "D",
    params: {
      scope: { type: "string", description: "What to purge.", required: true, enum: ["DBA", "SCHEMA", "TABLESPACE"] },
      name: { type: "string", description: "Schema name (scope SCHEMA) or tablespace name (scope TABLESPACE)." },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const statements: string[] = [];
      let owner: string | null = null;
      let impact: Row | undefined;
      if (a.scope === "DBA") {
        statements.push("PURGE DBA_RECYCLEBIN");
        impact = await recyclebinMb(db);
      } else {
        if (!a.name) throw new ToolError(`scope ${a.scope} needs the "name" parameter.`);
        if (a.scope === "SCHEMA") {
          owner = dictName(a.name, "schema");
          impact = await recyclebinMb(db, owner);
          const tss = await db.rows(
            "SELECT DISTINCT ts_name FROM dba_recyclebin WHERE owner = :o AND ts_name IS NOT NULL",
            { o: owner }
          );
          for (const r of tss) statements.push(`PURGE TABLESPACE "${r.ts_name}" USER ${q(a.name, "schema")}`);
        } else {
          const ts = dictName(a.name, "tablespace");
          await requireTablespace(db, ts);
          impact = await db.one(
            `SELECT COUNT(*) AS objects, ROUND(NVL(SUM(r.space * t.block_size), 0)/1048576, 1) AS size_mb
               FROM dba_recyclebin r JOIN dba_tablespaces t ON t.tablespace_name = r.ts_name WHERE r.ts_name = :ts`,
            { ts }
          );
          statements.push(`PURGE TABLESPACE "${ts}"`);
        }
      }
      if (statements.length === 0) return { executed: false, message: "Recycle bin is already empty for this scope.", impact };
      if (!a.confirm) return preview(statements, { impact });
      const results = await runAll(db, statements);
      return { executed: true, purged: impact, results, remaining: await recyclebinMb(db, owner) };
    },
  },
  {
    name: "oracle_shrink_segment",
    long: true,
    description:
      "Reclaims empty space inside a table or index online: enables row movement if needed, runs ALTER ... SHRINK SPACE and reports the size before and after. If the segment cannot be shrunk, the answer contains the ALTER TABLE ... MOVE alternative.",
    risk: "W",
    params: {
      schema: { type: "string", description: "Owner.", required: true },
      object_name: { type: "string", description: "Table or index name.", required: true },
      cascade: { type: "boolean", description: "Tables only: also shrink dependent indexes and LOBs (default true)." },
      compact_only: { type: "boolean", description: "Only compact rows without lowering the high-water mark (default false)." },
    },
    handler: async (a, { db }) => {
      const o = dictName(a.schema, "schema");
      const n = dictName(a.object_name, "object name");
      const obj = qn(a.schema, a.object_name);
      const types = (
        await db.rows(
          "SELECT object_type FROM dba_objects WHERE owner = :o AND object_name = :n AND object_type IN ('TABLE','INDEX')",
          { o, n }
        )
      ).map((r) => String(r.object_type));
      if (types.length === 0) throw new ToolError(`No table or index ${o}.${n} found.`);
      const compact = a.compact_only ? " COMPACT" : "";
      const statements: string[] = [];

      if (types.includes("TABLE")) {
        const cascade = a.cascade ?? true;
        const table = await requireTable(db, o, n);
        const before = await tableFootprint(db, o, n);
        const enabledHere = table.row_movement !== "ENABLED";
        try {
          if (enabledHere) {
            statements.push(`ALTER TABLE ${obj} ENABLE ROW MOVEMENT`);
            await db.exec(statements[statements.length - 1]);
          }
          statements.push(`ALTER TABLE ${obj} SHRINK SPACE${compact}${cascade ? " CASCADE" : ""}`);
          await db.exec(statements[statements.length - 1]);
        } catch (e) {
          const info = describeError(e);
          return {
            executed: true,
            success: false,
            ...info,
            statements,
            alternative: {
              note:
                "SHRINK is not possible for this segment (e.g. tablespace without ASSM, compressed table, function-based index, LONG column). " +
                "MOVE rebuilds the table; indexes become UNUSABLE afterwards and must be rebuilt.",
              steps: [`oracle_execute: ALTER TABLE ${obj} MOVE`, `oracle_rebuild_indexes: schema=${o}, table=${n}, only_unusable=true`],
            },
          };
        } finally {
          if (enabledHere) {
            try {
              await db.exec(`ALTER TABLE ${obj} DISABLE ROW MOVEMENT`);
              statements.push(`ALTER TABLE ${obj} DISABLE ROW MOVEMENT`);
            } catch {
              /* leave enabled */
            }
          }
        }
        const after = await tableFootprint(db, o, n);
        return {
          executed: true,
          success: true,
          object: `${o}.${n}`,
          statements,
          beforeMb: mb(before),
          afterMb: mb(after),
          freedMb: mb(before - after),
          hint: "The freed space is now free inside the tablespace. To give it back to the disk, shrink the datafile with oracle_resize_datafile.",
        };
      }

      const before = await segmentBytes(db, o, n);
      const sql = `ALTER INDEX ${obj} SHRINK SPACE${compact}`;
      await db.exec(sql);
      const after = await segmentBytes(db, o, n);
      return { executed: true, success: true, object: `${o}.${n}`, statements: [sql], beforeMb: mb(before), afterMb: mb(after), freedMb: mb(before - after) };
    },
  },
  {
    name: "oracle_rebuild_indexes",
    long: true,
    description:
      "Rebuilds indexes of one table or of all tables of a schema (including partitioned indexes). Typical after ALTER TABLE MOVE, which leaves indexes UNUSABLE. Continues on errors and reports each index.",
    risk: "W",
    params: {
      schema: { type: "string", description: "Owner of the tables.", required: true },
      table: { type: "string", description: "Restrict to the indexes of one table." },
      only_unusable: { type: "boolean", description: "Only rebuild indexes/partitions in status UNUSABLE (default true)." },
      online: { type: "boolean", description: "REBUILD ONLINE (default false)." },
    },
    handler: async (a, { db }) => {
      const o = dictName(a.schema, "schema");
      const t = a.table ? dictName(a.table, "table") : null;
      const onlyUnusable = a.only_unusable ?? true;
      const online = a.online ? " ONLINE" : "";
      const indexes = await db.rows(
        `SELECT i.owner, i.index_name, i.partitioned, i.status
           FROM dba_indexes i
          WHERE i.table_owner = :o AND (:t IS NULL OR i.table_name = :t)
            AND i.index_type NOT IN ('LOB', 'IOT - TOP', 'DOMAIN', 'CLUSTER')
            AND i.temporary = 'N' AND i.dropped = 'NO'
          ORDER BY i.table_name, i.index_name`,
        { o, t }
      );
      const statements: string[] = [];
      for (const i of indexes) {
        const idx = `"${i.owner}"."${i.index_name}"`;
        const b = { io: i.owner, ix: i.index_name };
        if (i.partitioned === "YES") {
          const parts = await db.rows(
            "SELECT partition_name, status, composite FROM dba_ind_partitions WHERE index_owner = :io AND index_name = :ix ORDER BY partition_position",
            b
          );
          if (parts.some((p) => p.composite === "YES")) {
            const subs = await db.rows(
              "SELECT subpartition_name, status FROM dba_ind_subpartitions WHERE index_owner = :io AND index_name = :ix ORDER BY partition_name, subpartition_position",
              b
            );
            for (const s of subs) {
              if (!onlyUnusable || s.status === "UNUSABLE") {
                statements.push(`ALTER INDEX ${idx} REBUILD SUBPARTITION "${s.subpartition_name}"${online}`);
              }
            }
          } else {
            for (const p of parts) {
              if (!onlyUnusable || p.status === "UNUSABLE") {
                statements.push(`ALTER INDEX ${idx} REBUILD PARTITION "${p.partition_name}"${online}`);
              }
            }
          }
        } else if (!onlyUnusable || i.status === "UNUSABLE") {
          statements.push(`ALTER INDEX ${idx} REBUILD${online}`);
        }
      }
      if (statements.length > 500) {
        throw new ToolError(`${statements.length} rebuilds would be needed; restrict with "table" or only_unusable=true.`);
      }
      const results = await runAll(db, statements);
      return {
        executed: true,
        indexesChecked: indexes.length,
        rebuilt: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      };
    },
  },
  {
    name: "oracle_resize_datafile",
    long: true,
    description:
      "Resizes a datafile or tempfile, normally to give free space back to the disk. Without target_size a datafile is shrunk to its high-water mark plus a small margin. See oracle_list_datafiles for file ids and the possible minimum.",
    risk: "D",
    params: {
      file: { type: "string", description: "Datafile id (number) or full file path. Tempfiles must be given by path.", required: true },
      target_size: { type: "string", description: "New size, e.g. 500M or 2G. Default: smallest possible size (datafiles only)." },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const key = String(a.file).trim();
      const byId = /^\d+$/.test(key);
      const df = await db.one(
        `SELECT * FROM (${DATAFILE_SQL}) WHERE ${byId ? "file_id = :k" : "file_name = :k"}`,
        { k: byId ? Number(key) : key }
      );
      let kind: "DATAFILE" | "TEMPFILE" = "DATAFILE";
      let file: Row | undefined = df;
      if (!file) {
        file = await db.one(
          `SELECT file_id, file_name, tablespace_name, ROUND(bytes/1048576, 1) AS size_mb FROM dba_temp_files
            WHERE ${byId ? "file_id = :k" : "file_name = :k"}`,
          { k: byId ? Number(key) : key }
        );
        kind = "TEMPFILE";
      }
      if (!file) throw new ToolError(`No datafile or tempfile matches "${key}". Use oracle_list_datafiles.`);

      let target: string;
      if (a.target_size) {
        target = sizeClause(a.target_size, "target_size");
      } else {
        if (kind === "TEMPFILE") throw new ToolError("target_size is required for tempfiles (or use oracle_shrink_temp_tablespace).");
        target = `${file.min_size_mb}M`;
      }
      const targetMb = mb(sizeToBytes(target));
      const sql = `ALTER DATABASE ${kind} ${lit(String(file.file_name))} RESIZE ${target}`;
      const impact = {
        file: file.file_name,
        tablespace: file.tablespace_name,
        currentMb: file.size_mb,
        minimumMb: kind === "DATAFILE" ? file.min_size_mb : undefined,
        targetMb,
        freedMb: Math.round((Number(file.size_mb) - targetMb) * 10) / 10,
      };
      if (kind === "DATAFILE" && targetMb < Number(file.min_size_mb)) {
        throw new ToolError(
          `Target ${targetMb} MB is below the high-water mark (${file.min_size_mb} MB); Oracle would raise ORA-03297. ` +
            "Shrink or move the segments at the end of the file first (oracle_shrink_segment).",
          impact
        );
      }
      if (!a.confirm) return preview([sql], { impact });
      await db.exec(sql);
      return { executed: true, statement: sql, ...impact };
    },
  },
  {
    name: "oracle_shrink_temp_tablespace",
    long: true,
    description:
      "Shrinks a temporary tablespace (ALTER TABLESPACE ... SHRINK SPACE) and returns the size before and after. Default: the database default temp tablespace.",
    risk: "W",
    params: {
      tablespace: { type: "string", description: "Temporary tablespace name (default: database default temp tablespace)." },
      keep_size: { type: "string", description: "Minimum size to keep, e.g. 100M (default: shrink as far as possible)." },
    },
    handler: async (a, { db }) => {
      let ts: string | null = a.tablespace ? dictName(a.tablespace, "tablespace") : null;
      if (!ts) {
        ts = await db.scalar<string>(
          "SELECT property_value FROM database_properties WHERE property_name = 'DEFAULT_TEMP_TABLESPACE'"
        );
      }
      if (!ts) throw new ToolError("Cannot determine the default temp tablespace; pass tablespace.");
      const info = await requireTablespace(db, ts);
      if (info.contents !== "TEMPORARY") throw new ToolError(`${ts} is not a temporary tablespace.`);
      const size = (): Promise<number | null> =>
        db.scalar<number>("SELECT NVL(SUM(bytes), 0) AS b FROM dba_temp_files WHERE tablespace_name = :ts", { ts });
      const before = Number(await size());
      const sql = `ALTER TABLESPACE "${ts}" SHRINK SPACE${a.keep_size ? ` KEEP ${sizeClause(a.keep_size, "keep_size")}` : ""}`;
      await db.exec(sql);
      const after = Number(await size());
      return { executed: true, statement: sql, beforeMb: mb(before), afterMb: mb(after), freedMb: mb(before - after) };
    },
  },
  {
    name: "oracle_manage_tablespace",
    long: true,
    description:
      "Tablespace administration: CREATE a tablespace, ADD_DATAFILE to an existing one, SET_AUTOEXTEND on all its datafiles, or DROP it. Datafile paths are derived from the existing datafile directory. DROP needs confirm=true.",
    risk: "D",
    params: {
      action: { type: "string", description: "What to do.", required: true, enum: ["CREATE", "ADD_DATAFILE", "SET_AUTOEXTEND", "DROP"] },
      tablespace: { type: "string", description: "Tablespace name.", required: true },
      size: { type: "string", description: "Initial size of the new datafile for CREATE / ADD_DATAFILE (default 100M)." },
      max_size: {
        type: "string",
        description: "Autoextend maximum, e.g. 4G or UNLIMITED (default UNLIMITED). For SET_AUTOEXTEND, OFF disables autoextend.",
      },
      including_contents: { type: "boolean", description: "DROP only: also drop all segments and delete the datafiles (default false)." },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const ts = dictName(a.tablespace, "tablespace");
      const size = sizeClause(a.size ?? "100M", "size");

      if (a.action === "CREATE") {
        const exists = await db.one("SELECT 1 AS x FROM dba_tablespaces WHERE tablespace_name = :ts", { ts });
        if (exists) throw new ToolError(`Tablespace ${ts} already exists.`);
        const path = await newDatafilePath(db, ts);
        const sql = `CREATE TABLESPACE "${ts}" DATAFILE ${path ? `${lit(path)} ` : ""}SIZE ${size} ${autoextendClause(a.max_size)}`;
        await db.exec(sql);
        return { executed: true, statement: sql };
      }

      const info = await requireTablespace(db, ts);

      if (a.action === "ADD_DATAFILE") {
        const path = await newDatafilePath(db, ts);
        const kind = info.contents === "TEMPORARY" ? "TEMPFILE" : "DATAFILE";
        const sql = `ALTER TABLESPACE "${ts}" ADD ${kind} ${path ? `${lit(path)} ` : ""}SIZE ${size} ${autoextendClause(a.max_size)}`;
        await db.exec(sql);
        return { executed: true, statement: sql };
      }

      if (a.action === "SET_AUTOEXTEND") {
        const temp = info.contents === "TEMPORARY";
        const files = await db.rows(
          `SELECT file_name FROM ${temp ? "dba_temp_files" : "dba_data_files"} WHERE tablespace_name = :ts ORDER BY file_id`,
          { ts }
        );
        const off = String(a.max_size ?? "").trim().toUpperCase() === "OFF";
        const clause = off ? "AUTOEXTEND OFF" : autoextendClause(a.max_size);
        const statements = files.map(
          (f) => `ALTER DATABASE ${temp ? "TEMPFILE" : "DATAFILE"} ${lit(String(f.file_name))} ${clause}`
        );
        const results = await runAll(db, statements);
        return { executed: true, results };
      }

      // DROP
      if (["SYSTEM", "SYSAUX"].includes(ts) || info.contents === "UNDO") {
        throw new ToolError(`Tablespace ${ts} is required by the database and cannot be dropped with this tool.`);
      }
      const defaults = await db.rows(
        "SELECT property_name, property_value FROM database_properties WHERE property_name IN ('DEFAULT_PERMANENT_TABLESPACE','DEFAULT_TEMP_TABLESPACE')"
      );
      const usedAsDefault = defaults.find((d) => d.property_value === ts);
      if (usedAsDefault) {
        throw new ToolError(`${ts} is the ${usedAsDefault.property_name}; assign another default first (ALTER DATABASE DEFAULT ... TABLESPACE).`);
      }
      const impact = await db.one(
        `SELECT (SELECT COUNT(*) FROM dba_segments WHERE tablespace_name = :ts) AS segments,
                (SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) FROM dba_segments WHERE tablespace_name = :ts) AS segments_mb,
                (SELECT COUNT(DISTINCT owner) FROM dba_segments WHERE tablespace_name = :ts) AS schemas,
                (SELECT COUNT(*) FROM dba_users WHERE default_tablespace = :ts) AS users_with_this_default
           FROM dual`,
        { ts }
      );
      const sql = `DROP TABLESPACE "${ts}"${a.including_contents ? " INCLUDING CONTENTS AND DATAFILES CASCADE CONSTRAINTS" : ""}`;
      if (!a.confirm) return preview([sql], { impact });
      await db.exec(sql);
      return { executed: true, statement: sql, dropped: impact };
    },
  },
  {
    name: "oracle_truncate_table",
    long: true,
    description:
      "Removes all rows of a table instantly and releases its space (TRUNCATE). Cannot be rolled back. The preview shows the row count, size and foreign keys pointing to the table.",
    risk: "D",
    params: {
      schema: { type: "string", description: "Owner.", required: true },
      table: { type: "string", description: "Table name.", required: true },
      drop_storage: { type: "boolean", description: "Release the allocated space (default true). false = REUSE STORAGE." },
      cascade: { type: "boolean", description: "Also truncate child tables referencing this table via ON DELETE CASCADE foreign keys (default false)." },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const o = dictName(a.schema, "schema");
      const t = dictName(a.table, "table");
      await db.assertUserSchema(o, "TRUNCATE");
      await requireTable(db, o, t);
      const obj = qn(a.schema, a.table);
      const sql = `TRUNCATE TABLE ${obj} ${(a.drop_storage ?? true) ? "DROP STORAGE" : "REUSE STORAGE"}${a.cascade ? " CASCADE" : ""}`;
      const before = await tableFootprint(db, o, t);
      if (!a.confirm) {
        const rows = await part(() => db.scalar<number>(`SELECT COUNT(*) AS c FROM ${obj}`));
        const referencedBy = await db.rows(
          `SELECT c.owner, c.table_name, c.constraint_name, c.status, c.delete_rule
             FROM dba_constraints c JOIN dba_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
            WHERE c.constraint_type = 'R' AND r.owner = :o AND r.table_name = :t`,
          { o, t }
        );
        return preview([sql], {
          impact: { rows, sizeMb: mb(before), referencedBy },
          warning: referencedBy.some((r) => r.status === "ENABLED")
            ? "Enabled foreign keys reference this table; TRUNCATE fails with ORA-02266 unless they are disabled or cascade=true applies."
            : undefined,
        });
      }
      await db.exec(sql);
      const after = await tableFootprint(db, o, t);
      return { executed: true, statement: sql, beforeMb: mb(before), afterMb: mb(after), freedMb: mb(before - after) };
    },
  },
  {
    name: "oracle_drop_schema_objects",
    long: true,
    description:
      "Schema reset: drops all (or filtered) objects of a schema but keeps the user itself, its password and grants. Handles tables, views, materialized views, sequences, procedures, functions, packages, triggers, synonyms, types and indexes. Oracle-maintained schemas are blocked.",
    risk: "D",
    params: {
      schema: { type: "string", description: "Schema to clean.", required: true },
      object_types: { type: "string[]", description: "Only drop these types, e.g. [\"TABLE\",\"VIEW\"]. Default: all supported types." },
      name_like: { type: "string", description: "Only drop objects whose name matches (case-insensitive, % wildcard)." },
      purge: { type: "boolean", description: "Drop tables with PURGE so they skip the recycle bin and space is freed at once (default true)." },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const o = dictName(a.schema, "schema");
      await db.assertUserSchema(o, "dropping schema objects");
      const purge = a.purge ?? true;
      const wanted: string[] = a.object_types?.length
        ? (a.object_types as string[]).map((x) => x.toUpperCase().replace(/_/g, " "))
        : DROP_ORDER.filter((x) => x !== "INDEX");
      const unsupported = wanted.filter((w) => !(DROP_ORDER as readonly string[]).includes(w));
      if (unsupported.length) {
        throw new ToolError(`Unsupported object type(s): ${unsupported.join(", ")}. Supported: ${DROP_ORDER.join(", ")}.`);
      }
      const objects = await db.rows(
        `SELECT object_name, object_type FROM dba_objects o
          WHERE o.owner = :o
            AND (:pat IS NULL OR UPPER(o.object_name) LIKE UPPER(:pat))
            AND o.object_name NOT LIKE 'BIN$%'
            AND o.secondary = 'N'
            AND NOT (o.object_type = 'SEQUENCE' AND o.object_name LIKE 'ISEQ$$%')
            AND NOT (o.object_type = 'TABLE' AND EXISTS (
                  SELECT 1 FROM dba_tables t WHERE t.owner = o.owner AND t.table_name = o.object_name
                     AND (t.nested = 'YES' OR t.iot_type = 'IOT_OVERFLOW')))
            AND NOT (o.object_type = 'TABLE' AND EXISTS (
                  SELECT 1 FROM dba_mviews m WHERE m.owner = o.owner AND m.mview_name = o.object_name))
            AND NOT (o.object_type = 'INDEX' AND EXISTS (
                  SELECT 1 FROM dba_indexes i WHERE i.owner = o.owner AND i.index_name = o.object_name
                     AND i.index_type IN ('LOB', 'IOT - TOP')))
          ORDER BY object_type, object_name`,
        { o, pat: likePattern(a.name_like) }
      );
      const statements: string[] = [];
      const counts: Record<string, number> = {};
      for (const type of DROP_ORDER) {
        if (!wanted.includes(type)) continue;
        for (const obj of objects.filter((x) => x.object_type === type)) {
          statements.push(dropStatement(type, o, String(obj.object_name), purge));
          counts[type] = (counts[type] ?? 0) + 1;
        }
      }
      if (statements.length === 0) return { executed: false, message: `No matching objects in schema ${o}.` };
      const sizeMb = await db.scalar<number>(
        "SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) AS m FROM dba_segments WHERE owner = :o",
        { o }
      );
      if (!a.confirm) {
        return preview(statements.slice(0, 100), {
          impact: { schema: o, objectsToDrop: statements.length, byType: counts, schemaSizeMb: sizeMb },
          statementsTruncated: statements.length > 100,
        });
      }
      // already gone (dropped as a dependent of an earlier object): ORA-00942, ORA-04043, ORA-01418, ORA-02289, ORA-01434, ORA-04080, ORA-12003
      const results = await runAll(db, statements, /^ORA-(00942|04043|01418|02289|01434|04080|12003)$/);
      const failed = results.filter((r) => !r.success);
      const sizeAfter = await db.scalar<number>(
        "SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) AS m FROM dba_segments WHERE owner = :o",
        { o }
      );
      return {
        executed: true,
        schema: o,
        dropped: results.length - failed.length,
        failed: failed.length,
        byType: counts,
        schemaSizeBeforeMb: sizeMb,
        schemaSizeAfterMb: sizeAfter,
        failures: failed.slice(0, 50),
        hint: purge ? undefined : "Tables went to the recycle bin; run oracle_purge_recyclebin to actually free the space.",
      };
    },
  },
  {
    name: "oracle_purge_audit_trail",
    long: true,
    description:
      "Deletes old audit records to free space: the unified audit trail (via DBMS_AUDIT_MGMT) and/or the traditional SYS.AUD$ table. Applies to the current container.",
    risk: "D",
    params: {
      older_than_days: { type: "number", description: "Delete records older than this many days (default 30). 0 = delete everything." },
      trail: { type: "string", description: "Which trail (default UNIFIED).", enum: ["UNIFIED", "STANDARD", "ALL"] },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const days = Math.max(0, Math.floor(a.older_than_days ?? 30));
      const trail = a.trail ?? "UNIFIED";
      const steps: { label: string; sql: string; binds: Record<string, unknown> }[] = [];
      if (trail === "UNIFIED" || trail === "ALL") {
        steps.push(
          days > 0
            ? {
                label: "unified",
                sql: `BEGIN
  DBMS_AUDIT_MGMT.SET_LAST_ARCHIVE_TIMESTAMP(
    audit_trail_type  => DBMS_AUDIT_MGMT.AUDIT_TRAIL_UNIFIED,
    last_archive_time => SYS_EXTRACT_UTC(SYSTIMESTAMP) - NUMTODSINTERVAL(:d, 'DAY'));
  DBMS_AUDIT_MGMT.CLEAN_AUDIT_TRAIL(
    audit_trail_type        => DBMS_AUDIT_MGMT.AUDIT_TRAIL_UNIFIED,
    use_last_arch_timestamp => TRUE);
END;`,
                binds: { d: days },
              }
            : {
                label: "unified",
                sql: `BEGIN
  DBMS_AUDIT_MGMT.CLEAN_AUDIT_TRAIL(
    audit_trail_type        => DBMS_AUDIT_MGMT.AUDIT_TRAIL_UNIFIED,
    use_last_arch_timestamp => FALSE);
END;`,
                binds: {},
              }
        );
      }
      if (trail === "STANDARD" || trail === "ALL") {
        steps.push(
          days > 0
            ? {
                label: "standard",
                sql: "DELETE FROM sys.aud$ WHERE ntimestamp# < SYS_EXTRACT_UTC(SYSTIMESTAMP) - NUMTODSINTERVAL(:d, 'DAY')",
                binds: { d: days },
              }
            : { label: "standard", sql: "TRUNCATE TABLE sys.aud$", binds: {} }
        );
      }
      const sizes = (): Promise<unknown> =>
        part(() =>
          db.one(
            `SELECT (SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) FROM dba_segments WHERE owner = 'AUDSYS') AS unified_audit_mb,
                    (SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) FROM dba_segments
                      WHERE owner = 'SYS' AND segment_name = 'AUD$') AS standard_audit_mb
               FROM dual`
          )
        );
      const before = await sizes();
      if (!a.confirm) {
        return preview(
          steps.map((s) => s.sql),
          { impact: { trail, olderThanDays: days, currentSize: before }, binds: days > 0 ? { d: days } : undefined }
        );
      }
      const results: Record<string, unknown>[] = [];
      for (const s of steps) {
        try {
          const r = await db.exec(s.sql, s.binds);
          results.push({ trail: s.label, success: true, rowsDeleted: r.rowsAffected });
        } catch (e) {
          results.push({ trail: s.label, success: false, ...describeError(e), sql: undefined });
        }
      }
      return {
        executed: true,
        olderThanDays: days,
        results,
        sizeBefore: before,
        sizeAfter: await sizes(),
        note: "The unified trail is stored in partitions; segment size drops only when whole partitions become empty.",
      };
    },
  },
  {
    name: "oracle_purge_sysaux",
    long: true,
    description:
      "Frees space in the SYSAUX tablespace: optimizer statistics history (STATS_HISTORY), old AWR snapshots (AWR_SNAPSHOTS) or expired advisor task results (ADVISOR_TASKS). Check v$sysaux_occupants via oracle_reclaimable_space first.",
    risk: "D",
    params: {
      target: { type: "string", description: "What to purge.", required: true, enum: ["STATS_HISTORY", "AWR_SNAPSHOTS", "ADVISOR_TASKS"] },
      older_than_days: { type: "number", description: "Keep the last N days (default 7). 0 = purge everything." },
      confirm: CONFIRM,
    },
    handler: async (a, { db }) => {
      const days = Math.max(0, Math.floor(a.older_than_days ?? 7));
      const occupants = (): Promise<unknown> =>
        part(() =>
          db.rows(
            `SELECT occupant_name, ROUND(space_usage_kbytes/1024, 1) AS size_mb FROM v$sysaux_occupants
              WHERE occupant_name IN ('SM/OPTSTAT', 'SM/AWR', 'SM/ADVISOR', 'SM/OTHER') ORDER BY occupant_name`
          )
        );
      const before = await occupants();

      if (a.target === "STATS_HISTORY") {
        const sql =
          days > 0
            ? "BEGIN DBMS_STATS.PURGE_STATS(SYSTIMESTAMP - NUMTODSINTERVAL(:d, 'DAY')); END;"
            : "BEGIN DBMS_STATS.PURGE_STATS(DBMS_STATS.PURGE_ALL); END;";
        if (!a.confirm) return preview([sql], { impact: { olderThanDays: days, sysaux: before } });
        await db.exec(sql, days > 0 ? { d: days } : {});
        return { executed: true, statement: sql, sysauxBefore: before, sysauxAfter: await occupants() };
      }

      if (a.target === "AWR_SNAPSHOTS") {
        const ranges = await db.rows(
          `SELECT dbid, MIN(snap_id) AS low_snap, MAX(snap_id) AS high_snap, COUNT(*) AS snapshots
             FROM dba_hist_snapshot
            WHERE :d = 0 OR end_interval_time < SYSTIMESTAMP - NUMTODSINTERVAL(:d, 'DAY')
            GROUP BY dbid`,
          { d: days }
        );
        const sql =
          "BEGIN DBMS_WORKLOAD_REPOSITORY.DROP_SNAPSHOT_RANGE(low_snap_id => :lo, high_snap_id => :hi, dbid => :dbid); END;";
        if (ranges.length === 0) return { executed: false, message: "No AWR snapshots in that range.", sysaux: before };
        if (!a.confirm) return preview([sql], { impact: { olderThanDays: days, ranges, sysaux: before } });
        const results: Record<string, unknown>[] = [];
        for (const r of ranges) {
          try {
            await db.exec(sql, { lo: r.low_snap, hi: r.high_snap, dbid: r.dbid });
            results.push({ ...r, success: true });
          } catch (e) {
            results.push({ ...r, success: false, error: describeError(e).message });
          }
        }
        return { executed: true, results, sysauxBefore: before, sysauxAfter: await occupants() };
      }

      // ADVISOR_TASKS
      const expire = Math.max(1, days);
      const steps = [
        {
          label: "shorten retention of the statistics advisor task",
          sql: `BEGIN
  FOR t IN (SELECT task_name FROM dba_advisor_tasks WHERE owner = 'SYS' AND task_name = 'AUTO_STATS_ADVISOR_TASK') LOOP
    DBMS_SQLTUNE.SET_TUNING_TASK_PARAMETER(task_name => t.task_name, parameter => 'EXECUTION_DAYS_TO_EXPIRE', value => :d);
  END LOOP;
END;`,
          binds: { d: expire } as Record<string, unknown>,
        },
        { label: "delete expired advisor tasks", sql: "BEGIN sys.prvt_advisor.delete_expired_tasks; END;", binds: {} },
      ];
      if (!a.confirm) {
        return preview(
          steps.map((s) => s.sql),
          { impact: { executionDaysToExpire: expire, sysaux: before } }
        );
      }
      const results: Record<string, unknown>[] = [];
      for (const s of steps) {
        try {
          await db.exec(s.sql, s.binds);
          results.push({ step: s.label, success: true });
        } catch (e) {
          results.push({ step: s.label, success: false, error: describeError(e).message });
        }
      }
      return { executed: true, results, sysauxBefore: before, sysauxAfter: await occupants() };
    },
  },
  {
    name: "oracle_gather_stats",
    long: true,
    description:
      "Gathers optimizer statistics for a schema or a single table (DBMS_STATS). Run it after large deletes, shrinks or loads so that row counts, size estimates and execution plans are accurate again.",
    risk: "W",
    params: {
      schema: { type: "string", description: "Schema name.", required: true },
      table: { type: "string", description: "Only this table (default: whole schema)." },
    },
    handler: async (a, { db }) => {
      const o = dictName(a.schema, "schema");
      const started = Date.now();
      if (a.table) {
        const t = dictName(a.table, "table");
        await requireTable(db, o, t);
        await db.exec("BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => :o, tabname => :t, cascade => TRUE); END;", {
          o: q(a.schema, "schema"),
          t: q(a.table, "table"),
        });
        const stats = await db.one(
          "SELECT num_rows, blocks, avg_row_len, last_analyzed FROM dba_tables WHERE owner = :o AND table_name = :t",
          { o, t }
        );
        return { executed: true, scope: `${o}.${t}`, seconds: Math.round((Date.now() - started) / 100) / 10, stats };
      }
      const exists = await db.one("SELECT 1 AS x FROM dba_users WHERE username = :o", { o });
      if (!exists) throw new ToolError(`Schema ${o} does not exist.`);
      await db.exec("BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(ownname => :o); END;", { o: q(a.schema, "schema") });
      const summary = await db.one(
        "SELECT COUNT(*) AS tables, SUM(num_rows) AS total_rows, MIN(last_analyzed) AS oldest_stats FROM dba_tables WHERE owner = :o",
        { o }
      );
      return { executed: true, scope: o, seconds: Math.round((Date.now() - started) / 100) / 10, summary };
    },
  },
];
