/** E. Storage analysis (read-only). */

import type { Db, Row } from "../db.js";
import { clamp, type ToolDef } from "../registry.js";
import { dictName } from "../util.js";

/** XE (18c/21c) limit for user data across the whole CDB, in MB. */
const XE_USER_DATA_LIMIT_MB = 12 * 1024;

/** Runs a part of a report and turns an error into a note instead of failing the whole tool. */
export async function part<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** High-water mark per datafile: the smallest size the file can be resized to. */
export const DATAFILE_SQL = `
  SELECT f.file_id, f.file_name, f.tablespace_name, 'DATAFILE' AS file_type,
         ROUND(f.bytes/1048576, 1) AS size_mb,
         f.autoextensible,
         ROUND(f.maxbytes/1048576, 1) AS max_mb,
         ROUND(f.increment_by * t.block_size/1048576, 1) AS increment_mb,
         f.online_status AS status,
         CEIL((NVL(h.hwm_blocks, 0) + 128) * t.block_size/1048576) AS min_size_mb,
         GREATEST(ROUND(f.bytes/1048576, 1) - CEIL((NVL(h.hwm_blocks, 0) + 128) * t.block_size/1048576), 0) AS shrinkable_mb
    FROM dba_data_files f
    JOIN dba_tablespaces t ON t.tablespace_name = f.tablespace_name
    LEFT JOIN (SELECT file_id, MAX(block_id + blocks - 1) AS hwm_blocks FROM dba_extents GROUP BY file_id) h
           ON h.file_id = f.file_id`;

export async function recyclebinMb(db: Db, owner: string | null = null): Promise<Row | undefined> {
  return db.one(
    `SELECT COUNT(*) AS objects, ROUND(NVL(SUM(r.space * t.block_size), 0)/1048576, 1) AS size_mb
       FROM dba_recyclebin r LEFT JOIN dba_tablespaces t ON t.tablespace_name = r.ts_name
      WHERE (:o IS NULL OR r.owner = :o)`,
    { o: owner }
  );
}

export const TEMP_SQL = `
  SELECT f.tablespace_name,
         ROUND(f.bytes/1048576, 1) AS size_mb,
         ROUND((NVL(s.tablespace_size, f.bytes) - NVL(s.free_space, 0))/1048576, 1) AS used_mb,
         ROUND(NVL(s.free_space, 0)/1048576, 1) AS free_mb,
         ROUND(f.maxbytes/1048576, 1) AS max_mb
    FROM (SELECT tablespace_name, SUM(bytes) AS bytes, SUM(GREATEST(bytes, maxbytes)) AS maxbytes
            FROM dba_temp_files GROUP BY tablespace_name) f
    LEFT JOIN dba_temp_free_space s ON s.tablespace_name = f.tablespace_name`;

export const storageTools: ToolDef[] = [
  {
    name: "oracle_storage_overview",
    description:
      "One-call storage summary of the current container: total datafile size, used and free space, temp size, recycle bin, biggest tablespaces and schemas. On Express Edition it also shows how close the user data is to the 12 GB XE limit. Start here for 'why is the database full'.",
    risk: "R",
    params: {},
    handler: async (_a, { db }) => {
      const container = await db.currentContainer();
      const edition = await part(() => db.scalar<string>("SELECT edition FROM v$instance"));
      const totals = await db.one(
        `SELECT (SELECT ROUND(SUM(bytes)/1048576, 1) FROM dba_data_files) AS datafiles_mb,
                (SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) FROM dba_temp_files) AS tempfiles_mb,
                (SELECT ROUND(SUM(bytes)/1048576, 1) FROM dba_segments) AS segments_mb,
                (SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) FROM dba_free_space) AS free_in_datafiles_mb
           FROM dual`
      );
      const userData = await part(() =>
        db.scalar<number>(
          `SELECT ROUND(NVL(SUM(s.bytes), 0)/1048576, 1) AS mb
             FROM dba_segments s JOIN dba_tablespaces t ON t.tablespace_name = s.tablespace_name
            WHERE t.contents = 'PERMANENT' AND s.tablespace_name NOT IN ('SYSTEM', 'SYSAUX')`
        )
      );
      const tablespaces = await db.rows(
        `SELECT d.tablespace_name, ROUND(d.bytes/1048576, 1) AS size_mb,
                ROUND((d.bytes - NVL(f.bytes, 0))/1048576, 1) AS used_mb
           FROM (SELECT tablespace_name, SUM(bytes) AS bytes FROM dba_data_files GROUP BY tablespace_name) d
           LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS bytes FROM dba_free_space GROUP BY tablespace_name) f
                  ON f.tablespace_name = d.tablespace_name
          ORDER BY d.bytes - NVL(f.bytes, 0) DESC FETCH FIRST 8 ROWS ONLY`
      );
      const schemas = await db.rows(
        `SELECT owner, ROUND(SUM(bytes)/1048576, 1) AS size_mb FROM dba_segments
          GROUP BY owner ORDER BY SUM(bytes) DESC FETCH FIRST 8 ROWS ONLY`
      );
      const recyclebin = await part(() => recyclebinMb(db));

      const out: Record<string, unknown> = {
        container,
        edition,
        totals,
        topTablespaces: tablespaces,
        topSchemas: schemas,
        recyclebin,
      };
      if (edition === "XE") {
        const used = typeof userData === "number" ? userData : null;
        out.xeLimit = {
          limitMb: XE_USER_DATA_LIMIT_MB,
          userDataInThisContainerMb: userData,
          percentOfLimit: used === null ? null : Math.round((used / XE_USER_DATA_LIMIT_MB) * 1000) / 10,
          note:
            "XE allows 12 GB of user data across all PDBs together (SYSTEM, SYSAUX, UNDO and TEMP do not count). " +
            "This figure is an estimate for the current container only; ORA-12954 is raised when the limit is hit.",
        };
      } else {
        out.userDataMb = userData;
      }
      out.next = "oracle_reclaimable_space shows what can be freed and which tool does it.";
      return out;
    },
  },
  {
    name: "oracle_tablespace_usage",
    description:
      "Size, used and free space per tablespace including the autoextend maximum and percent used. Includes UNDO and TEMP unless include_temp_undo=false.",
    risk: "R",
    params: {
      include_temp_undo: { type: "boolean", description: "Include UNDO and TEMP tablespaces (default true)." },
    },
    handler: async (a, { db }) => {
      const all = a.include_temp_undo ?? true;
      const permanent = await db.rows(
        `SELECT t.tablespace_name, t.contents, t.status, t.bigfile,
                ROUND(NVL(d.bytes, 0)/1048576, 1) AS size_mb,
                ROUND((NVL(d.bytes, 0) - NVL(f.bytes, 0))/1048576, 1) AS used_mb,
                ROUND(NVL(f.bytes, 0)/1048576, 1) AS free_mb,
                ROUND(NVL(d.maxbytes, 0)/1048576, 1) AS max_mb,
                ROUND(100 * (NVL(d.bytes, 0) - NVL(f.bytes, 0)) / NULLIF(d.bytes, 0), 1) AS pct_used,
                ROUND(100 * (NVL(d.bytes, 0) - NVL(f.bytes, 0)) / NULLIF(d.maxbytes, 0), 1) AS pct_of_max,
                d.files
           FROM dba_tablespaces t
           LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS bytes, SUM(GREATEST(bytes, maxbytes)) AS maxbytes,
                             COUNT(*) AS files
                        FROM dba_data_files GROUP BY tablespace_name) d ON d.tablespace_name = t.tablespace_name
           LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS bytes FROM dba_free_space GROUP BY tablespace_name) f
                  ON f.tablespace_name = t.tablespace_name
          WHERE t.contents = 'PERMANENT' OR (:a = 1 AND t.contents = 'UNDO')
          ORDER BY NVL(d.bytes, 0) - NVL(f.bytes, 0) DESC`,
        { a: all ? 1 : 0 }
      );
      const out: Record<string, unknown> = { container: await db.currentContainer(), tablespaces: permanent };
      if (all) out.temp = await part(() => db.rows(TEMP_SQL));
      return out;
    },
  },
  {
    name: "oracle_list_datafiles",
    description:
      "Lists datafiles and tempfiles with path, size, autoextend settings and, for datafiles, the minimum size the file could be shrunk to (high-water mark) and the MB that a resize would free.",
    risk: "R",
    params: { tablespace: { type: "string", description: "Restrict to one tablespace." } },
    handler: async (a, { db }) => {
      const ts = a.tablespace ? dictName(a.tablespace, "tablespace") : null;
      const datafiles = await db.rows(
        `${DATAFILE_SQL} WHERE (:ts IS NULL OR f.tablespace_name = :ts) ORDER BY f.tablespace_name, f.file_id`,
        { ts }
      );
      const tempfiles = await db.rows(
        `SELECT f.file_id, f.file_name, f.tablespace_name, 'TEMPFILE' AS file_type,
                ROUND(f.bytes/1048576, 1) AS size_mb, f.autoextensible,
                ROUND(f.maxbytes/1048576, 1) AS max_mb, f.status
           FROM dba_temp_files f
          WHERE (:ts IS NULL OR f.tablespace_name = :ts) ORDER BY f.tablespace_name, f.file_id`,
        { ts }
      );
      return {
        datafiles,
        tempfiles,
        note: "min_size_mb is the high-water mark plus a small margin. Use oracle_resize_datafile to shrink, oracle_shrink_temp_tablespace for temp.",
      };
    },
  },
  {
    name: "oracle_schema_sizes",
    description: "Space used per schema in MB, split into tables, indexes and LOBs, largest first.",
    risk: "R",
    params: { top_n: { type: "number", description: "Number of schemas to return (default 20)." } },
    handler: async (a, { db, config }) =>
      db.list(
        `SELECT owner,
                ROUND(SUM(bytes)/1048576, 1) AS total_mb,
                ROUND(SUM(CASE WHEN segment_type LIKE 'TABLE%' OR segment_type = 'NESTED TABLE' THEN bytes ELSE 0 END)/1048576, 1) AS table_mb,
                ROUND(SUM(CASE WHEN segment_type LIKE 'INDEX%' THEN bytes ELSE 0 END)/1048576, 1) AS index_mb,
                ROUND(SUM(CASE WHEN segment_type LIKE 'LOB%' THEN bytes ELSE 0 END)/1048576, 1) AS lob_mb,
                COUNT(*) AS segments
           FROM dba_segments
          GROUP BY owner
          ORDER BY SUM(bytes) DESC`,
        {},
        clamp(a.top_n, 20, config.maxRows)
      ),
  },
  {
    name: "oracle_top_segments",
    description:
      "The largest segments (tables, indexes, LOBs, partitions). LOB and index segments are mapped to their table (and LOB column), so cryptic SYS_LOB... names become readable.",
    risk: "R",
    params: {
      schema: { type: "string", description: "Restrict to one schema." },
      tablespace: { type: "string", description: "Restrict to one tablespace." },
      top_n: { type: "number", description: "Number of segments to return (default 25)." },
    },
    handler: async (a, { db, config }) =>
      db.list(
        `SELECT s.owner, s.segment_name, s.partition_name, s.segment_type, s.tablespace_name,
                ROUND(s.bytes/1048576, 1) AS size_mb,
                COALESCE(l.table_name, i.table_name) AS parent_table,
                l.column_name AS lob_column
           FROM (SELECT owner, segment_name, partition_name, segment_type, tablespace_name, bytes
                   FROM dba_segments
                  WHERE (:o IS NULL OR owner = :o) AND (:ts IS NULL OR tablespace_name = :ts)
                  ORDER BY bytes DESC FETCH FIRST :n ROWS ONLY) s
           LEFT JOIN dba_lobs l
                  ON s.segment_type LIKE 'LOB%' AND l.owner = s.owner
                 AND (l.segment_name = s.segment_name OR l.index_name = s.segment_name)
           LEFT JOIN dba_indexes i
                  ON s.segment_type LIKE 'INDEX%' AND i.owner = s.owner AND i.index_name = s.segment_name
          ORDER BY s.bytes DESC`,
        {
          o: a.schema ? dictName(a.schema, "schema") : null,
          ts: a.tablespace ? dictName(a.tablespace, "tablespace") : null,
          n: clamp(a.top_n, 25, config.maxRows),
        },
        config.maxRows
      ),
  },
  {
    name: "oracle_list_recyclebin",
    description:
      "Lists dropped objects that still occupy space in the recycle bin, with original name, drop time and size. Purge them with oracle_purge_recyclebin.",
    risk: "R",
    params: { schema: { type: "string", description: "Restrict to one schema." } },
    handler: async (a, { db, config }) => {
      const o = a.schema ? dictName(a.schema, "schema") : null;
      const res = await db.list(
        `SELECT r.owner, r.original_name, r.object_name, r.type, r.ts_name AS tablespace_name, r.droptime,
                r.can_purge, ROUND(r.space * t.block_size/1048576, 2) AS size_mb
           FROM dba_recyclebin r LEFT JOIN dba_tablespaces t ON t.tablespace_name = r.ts_name
          WHERE (:o IS NULL OR r.owner = :o)
          ORDER BY r.space DESC NULLS LAST`,
        { o },
        config.maxRows
      );
      return { total: await recyclebinMb(db, o), ...res };
    },
  },
  {
    name: "oracle_reclaimable_space",
    description:
      "Estimates where space can be freed and names the tool for each item: recycle bin, datafiles above the high-water mark, tables with much empty space (shrink candidates), audit trail, SYSAUX occupants, optimizer statistics history and temp. Read-only; run this before any cleanup.",
    risk: "R",
    params: { schema: { type: "string", description: "Restrict the shrink-candidate analysis to one schema." } },
    handler: async (a, { db }) => {
      const o = a.schema ? dictName(a.schema, "schema") : null;
      const recyclebin = await part(async () => ({
        ...(await recyclebinMb(db)),
        tool: "oracle_purge_recyclebin",
      }));
      const datafiles = await part(async () => {
        const files = await db.rows(
          `SELECT * FROM (${DATAFILE_SQL}) WHERE shrinkable_mb >= 1 ORDER BY shrinkable_mb DESC FETCH FIRST 20 ROWS ONLY`
        );
        return {
          shrinkableMb: Math.round(files.reduce((s, f) => s + Number(f.shrinkable_mb ?? 0), 0) * 10) / 10,
          files: files.map((f) => ({
            file_id: f.file_id,
            file_name: f.file_name,
            tablespace_name: f.tablespace_name,
            size_mb: f.size_mb,
            min_size_mb: f.min_size_mb,
            shrinkable_mb: f.shrinkable_mb,
          })),
          tool: "oracle_resize_datafile",
          note: "Space below the high-water mark only becomes resizable after shrinking/moving the segments at the end of the file.",
        };
      });
      const shrinkCandidates = await part(async () => ({
        tables: await db.rows(
          `SELECT t.owner, t.table_name,
                  ROUND(t.blocks * ts.block_size/1048576, 1) AS allocated_mb,
                  ROUND(t.num_rows * t.avg_row_len/1048576, 1) AS data_mb,
                  ROUND((t.blocks * ts.block_size - t.num_rows * t.avg_row_len * 1.25)/1048576, 1) AS est_reclaimable_mb,
                  t.last_analyzed
             FROM dba_tables t JOIN dba_tablespaces ts ON ts.tablespace_name = t.tablespace_name
            WHERE (:o IS NOT NULL AND t.owner = :o
                   OR :o IS NULL AND t.owner IN (SELECT username FROM dba_users WHERE oracle_maintained = 'N'))
              AND t.num_rows IS NOT NULL AND t.blocks > 128 AND t.temporary = 'N'
              AND (t.blocks * ts.block_size - t.num_rows * t.avg_row_len * 1.25) > 10 * 1048576
            ORDER BY 5 DESC FETCH FIRST 20 ROWS ONLY`,
          { o }
        ),
        tool: "oracle_shrink_segment",
        note: "Estimate from optimizer statistics (run oracle_gather_stats first if last_analyzed is old). LOB space is not included.",
      }));
      const audit = await part(async () => ({
        ...(await db.one(
          `SELECT (SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) FROM dba_segments WHERE owner = 'AUDSYS') AS unified_audit_mb,
                  (SELECT ROUND(NVL(SUM(bytes), 0)/1048576, 1) FROM dba_segments
                    WHERE owner = 'SYS' AND segment_name IN ('AUD$', 'FGA_LOG$')) AS standard_audit_mb
             FROM dual`
        )),
        tool: "oracle_purge_audit_trail",
      }));
      const sysaux = await part(async () => ({
        occupants: await db.rows(
          `SELECT occupant_name, occupant_desc, schema_name, ROUND(space_usage_kbytes/1024, 1) AS size_mb
             FROM v$sysaux_occupants WHERE space_usage_kbytes > 0
            ORDER BY space_usage_kbytes DESC FETCH FIRST 8 ROWS ONLY`
        ),
        statsHistory: await part(() =>
          db.one(
            `SELECT DBMS_STATS.GET_STATS_HISTORY_RETENTION AS retention_days,
                    DBMS_STATS.GET_STATS_HISTORY_AVAILABILITY AS oldest_available FROM dual`
          )
        ),
        tool: "oracle_purge_sysaux",
        note: "SM/OPTSTAT = statistics history, SM/AWR = AWR snapshots, SM/ADVISOR = advisor tasks.",
      }));
      const temp = await part(async () => ({
        tablespaces: await db.rows(TEMP_SQL),
        tool: "oracle_shrink_temp_tablespace",
      }));
      return { container: await db.currentContainer(), recyclebin, datafiles, shrinkCandidates, audit, sysaux, temp };
    },
  },
];
