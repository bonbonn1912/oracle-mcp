#!/usr/bin/env node
/** oracle-mcp: MCP server (stdio) for Oracle databases, built for the Gemini CLI. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Config, loadSettings, type Settings } from "./config.js";
import { Db, describeError } from "./db.js";
import { coerceArgs, type ConnectionManager, inputSchema, toolDescription, type ToolDef } from "./registry.js";
import { cleanupTools } from "./tools/cleanup.js";
import { exportTools } from "./tools/export.js";
import { monitoringTools } from "./tools/monitoring.js";
import { schemaTools } from "./tools/schema.js";
import { sessionTools } from "./tools/session.js";
import { sqlTools } from "./tools/sql.js";
import { storageTools } from "./tools/storage.js";
import { userTools } from "./tools/users.js";
import { ToolError } from "./util.js";

export const ALL_TOOLS: ToolDef[] = [
  ...sessionTools,
  ...sqlTools,
  ...schemaTools,
  ...userTools,
  ...storageTools,
  ...cleanupTools,
  ...monitoringTools,
  ...exportTools,
];

/** Read tools that only work with DBA_* / V$ views. */
const DBA_ONLY_READ = new Set([
  "oracle_list_containers",
  "oracle_storage_overview",
  "oracle_tablespace_usage",
  "oracle_list_datafiles",
  "oracle_schema_sizes",
  "oracle_top_segments",
  "oracle_list_recyclebin",
  "oracle_reclaimable_space",
  "oracle_list_sessions",
  "oracle_list_locks",
  "oracle_top_sql",
  "oracle_get_parameters",
  "oracle_alert_log",
]);
/** Write tools that work for ordinary users too; every other write tool is an administration tool. */
const USER_LEVEL_WRITE = new Set([
  "oracle_execute",
  "oracle_execute_plsql",
  "oracle_run_script",
  "oracle_commit",
  "oracle_rollback",
  "oracle_set_current_schema",
  "oracle_switch_container",
]);

export function requiresDba(t: ToolDef): boolean {
  return t.risk === "R" ? DBA_ONLY_READ.has(t.name) : !USER_LEVEL_WRITE.has(t.name);
}

function log(message: string): void {
  // stdout belongs to the MCP protocol; diagnostics go to stderr
  process.stderr.write(`[oracle-mcp] ${message}\n`);
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function fail(info: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(info) }], isError: true };
}

async function main(): Promise<void> {
  let settings: Settings | null = null;
  let configError: string | null = null;
  try {
    settings = loadSettings();
  } catch (e) {
    // Still start, so that the client can list the tools and show a useful error on the first call.
    configError = (e as Error).message;
    log(`configuration error: ${configError}`);
  }

  const configs: Config[] = settings ? [...settings.connections.values()] : [];
  const multi = configs.length > 1;
  const allReadOnly = configs.length > 0 && configs.every((c) => c.readOnly);
  const allLimited = configs.length > 0 && configs.every((c) => c.dictionary === "all");
  // A tool is only hidden when no configured connection could use it; per-connection limits are enforced on each call.
  const tools = ALL_TOOLS.filter((t) => !(allReadOnly && t.risk !== "R") && !(allLimited && requiresDba(t)));
  const byName = new Map(tools.map((t) => [t.name, t]));

  const dbs = new Map<string, Db>();
  let active = settings?.defaultName ?? "local";
  const dbFor = (cfg: Config): Db => {
    let db = dbs.get(cfg.name);
    if (!db) {
      db = new Db(cfg);
      dbs.set(cfg.name, db);
    }
    return db;
  };
  const manager: ConnectionManager = {
    list: () => configs,
    active: () => active,
    setActive: (name) => {
      active = name;
    },
    isOpen: (name) => dbs.get(name)?.isOpen ?? false,
  };

  const server = new Server({ name: "oracle-mcp", version: "0.2.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: toolDescription(t),
      inputSchema: inputSchema(t, multi) as { type: "object"; properties?: Record<string, unknown> },
      annotations: { readOnlyHint: t.risk === "R", destructiveHint: t.risk === "D" },
    })),
  }));

  // One statement at a time: tool calls are serialised.
  let queue: Promise<unknown> = Promise.resolve();

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const run = async (): Promise<ToolResult> => {
      const tool = byName.get(request.params.name);
      if (!tool) {
        const hidden = ALL_TOOLS.some((t) => t.name === request.params.name);
        return fail({
          error: "UNKNOWN_TOOL",
          message: hidden
            ? `${request.params.name} is disabled by the configuration (read-only / limited dictionary on every connection).`
            : `Unknown tool ${request.params.name}.`,
        });
      }
      if (!settings) return fail({ error: "CONFIG_ERROR", message: configError });

      // ---- which connection? explicit "connection" argument, otherwise the active one
      const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
      const requested =
        !tool.noConnection && typeof rawArgs.connection === "string" && rawArgs.connection.trim() !== ""
          ? rawArgs.connection.trim().toLowerCase()
          : null;
      const name = requested ?? active;
      const config = settings.connections.get(name);
      if (!config) {
        return fail({
          error: "UNKNOWN_CONNECTION",
          message: `No connection named "${name}". Available: ${configs.map((c) => c.name).join(", ")}. Add servers in ${settings.connectionsFile}.`,
        });
      }
      if (config.readOnly && tool.risk !== "R") {
        return fail({
          error: "READ_ONLY",
          connection: name,
          message: `Connection "${name}" is read-only; ${tool.name} changes the database and is not allowed there.`,
        });
      }

      const db = dbFor(config);
      try {
        const args = coerceArgs(tool, rawArgs);
        if (requiresDba(tool) && (await db.dict()) === "all") {
          throw new ToolError(
            `${tool.name} needs the DBA_* / V$ dictionary views, which the user of connection "${name}" may not read ` +
              "(grant SELECT_CATALOG_ROLE or SELECT ANY DICTIONARY to enable it). Tools for schemas, objects, " +
              "DDL, queries and export work without it."
          );
        }
        db.setCallTimeout(tool.long ? 0 : null);
        const result = await tool.handler(args, { db, config, connections: manager });
        let payload: unknown = result;
        if (result && typeof result === "object" && !Array.isArray(result)) {
          payload = {
            ...(multi && !tool.noConnection ? { connection: name } : {}),
            ...(db.reconnectNotice ? { notice: db.reconnectNotice } : {}),
            ...(result as Record<string, unknown>),
          };
        }
        db.reconnectNotice = null;
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        const info = describeError(err) as unknown as Record<string, unknown>;
        if (multi) info.connection = name;
        const code = String(info.error);
        if (/^ORA-(01017|28000|28001)$/.test(code)) {
          info.hint =
            `Login failed for connection "${name}". Check user, password (${config.passwordVar}) and privilege. ` +
            "For SYS AS SYSDBA: if the password is right, the password file may be out of sync; reset it in CDB$ROOT with ALTER USER sys IDENTIFIED BY ... CONTAINER = ALL.";
        } else if (/^(ORA-12514|ORA-12541|ORA-12154|ORA-12170|ORA-12545|NJS-5\d\d)$/.test(code)) {
          info.hint = `Cannot reach ${config.connectString} (connection "${name}"). Check that the database and listener are running and that host, port and service are correct.`;
        }
        return fail(info);
      } finally {
        db.setCallTimeout(null);
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  });

  const shutdown = async (): Promise<void> => {
    try {
      await Promise.all([...dbs.values()].map((d) => d.close()));
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("close", () => void shutdown());

  await server.connect(new StdioServerTransport());
  if (!settings) {
    log("started without valid configuration");
    return;
  }
  log(`ready: ${tools.length} tools, ${configs.length} connection(s), active: ${active}`);
  for (const c of configs) {
    log(
      `  ${c.name}: ${c.user}@${c.connectString}${c.privilege ? ` as ${c.privilege}` : ""}${c.readOnly ? " (read-only)" : ""}${c.password ? "" : ` [no password: ${c.passwordVar}]`}`
    );
  }
}

main().catch((e) => {
  log(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
