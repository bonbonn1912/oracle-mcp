/** H. Export of query results to files. */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import oracledb from "oracledb";
import { projectRoot } from "../config.js";
import type { ToolDef } from "../registry.js";
import { cleanStatement, isQuery, normalizeValue, parseBinds, ToolError } from "../util.js";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const exportTools: ToolDef[] = [
  {
    name: "oracle_export_query",
    description:
      "Runs a SELECT and writes the complete result (no row limit) to a CSV or JSON file in the export directory (ORACLE_EXPORT_DIR, default ./exports). Returns the file path and row count. Use this instead of oracle_query for large results.",
    risk: "R",
    long: true,
    params: {
      sql: { type: "string", description: "A single SELECT statement.", required: true },
      format: { type: "string", description: "File format.", required: true, enum: ["CSV", "JSON"] },
      filename: { type: "string", description: "File name without directory, e.g. employees.csv.", required: true },
      binds_json: { type: "string", description: 'Bind values as JSON string, e.g. {"dept": 10}.' },
    },
    handler: async (a, { db, config }) => {
      const sql = cleanStatement(a.sql);
      if (!isQuery(sql)) throw new ToolError("oracle_export_query only accepts SELECT / WITH statements.");
      const ext = a.format === "CSV" ? ".csv" : ".json";
      let name = path.basename(String(a.filename).trim()).replace(/[^A-Za-z0-9._-]/g, "_");
      if (name === "" || name === "." || name === "..") throw new ToolError("Invalid filename.");
      if (!name.toLowerCase().endsWith(ext)) name += ext;
      const dir = path.resolve(projectRoot(), config.exportDir);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, name);

      const conn = await db.connection();
      const res = await conn.execute<unknown[]>(sql, parseBinds(a.binds_json) as oracledb.BindParameters, {
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        fetchArraySize: 500,
      });
      const rs = res.resultSet;
      if (!rs) throw new ToolError("Statement did not return a result set.");
      const columns = (res.metaData ?? []).map((m) => m.name);
      const out = createWriteStream(file, { encoding: "utf8" });
      const write = async (chunk: string): Promise<void> => {
        if (!out.write(chunk)) await once(out, "drain");
      };
      let count = 0;
      try {
        if (a.format === "CSV") await write(`${columns.map(csvCell).join(",")}\n`);
        else await write("[");
        for (;;) {
          const rows = await rs.getRows(500);
          if (rows.length === 0) break;
          let chunk = "";
          for (const r of rows) {
            const values = (r as unknown[]).map((v) => normalizeValue(v, false));
            if (a.format === "CSV") {
              chunk += `${values.map(csvCell).join(",")}\n`;
            } else {
              const obj: Record<string, unknown> = {};
              columns.forEach((c, i) => (obj[c] = values[i]));
              chunk += `${count === 0 ? "\n" : ",\n"}${JSON.stringify(obj)}`;
            }
            count++;
          }
          await write(chunk);
        }
        if (a.format === "JSON") await write(count === 0 ? "]\n" : "\n]\n");
      } finally {
        try {
          await rs.close();
        } catch {
          /* ignore */
        }
        out.end();
        await once(out, "close").catch(() => undefined);
      }
      return { file, format: a.format, rows: count, columns };
    },
  },
];
