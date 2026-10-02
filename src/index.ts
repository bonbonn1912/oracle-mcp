#!/usr/bin/env node
/** oracle-mcp: MCP server (stdio) for local Oracle databases, built for the Gemini CLI. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Config, loadConfig } from "./config.js";
import { Db, describeError } from "./db.js";
import { coerceArgs, inputSchema, toolDescription, type ToolDef } from "./registry.js";
import { cleanupTools } from "./tools/cleanup.js";
import { exportTools } from "./tools/export.js";
import { monitoringTools } from "./tools/monitoring.js";
import { schemaTools } from "./tools/schema.js";
import { sessionTools } from "./tools/session.js";
import { sqlTools } from "./tools/sql.js";
import { storageTools } from "./tools/storage.js";
import { userTools } from "./tools/users.js";

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

function log(message: string): void {
  // stdout belongs to the MCP protocol; diagnostics go to stderr
  process.stderr.write(`[oracle-mcp] ${message}\n`);
}

async function main(): Promise<void> {
  let config: Config | null = null;
  let configError: string | null = null;
  try {
    config = loadConfig();
  } catch (e) {
    // Still start, so that the client can list the tools and show a useful error on the first call.
    configError = (e as Error).message;
    log(`configuration error: ${configError}`);
  }

  const tools = config?.readOnly ? ALL_TOOLS.filter((t) => t.risk === "R") : ALL_TOOLS;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const db = config ? new Db(config) : null;

  const server = new Server({ name: "oracle-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: toolDescription(t),
      inputSchema: inputSchema(t) as { type: "object"; properties?: Record<string, unknown> },
      annotations: { readOnlyHint: t.risk === "R", destructiveHint: t.risk === "D" },
    })),
  }));

  // One session, one statement at a time: tool calls are serialised.
  let queue: Promise<unknown> = Promise.resolve();

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const run = async (): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> => {
      const fail = (info: unknown): { content: { type: "text"; text: string }[]; isError: boolean } => ({
        content: [{ type: "text", text: JSON.stringify(info) }],
        isError: true,
      });
      const tool = byName.get(request.params.name);
      if (!tool) {
        const hidden = ALL_TOOLS.some((t) => t.name === request.params.name);
        return fail({
          error: "UNKNOWN_TOOL",
          message: hidden
            ? `${request.params.name} is disabled because ORACLE_READ_ONLY=true.`
            : `Unknown tool ${request.params.name}.`,
        });
      }
      if (!config || !db) return fail({ error: "CONFIG_ERROR", message: configError });
      try {
        const args = coerceArgs(tool, request.params.arguments);
        db.setCallTimeout(tool.long ? 0 : null);
        const result = await tool.handler(args, { db, config });
        const payload =
          db.reconnectNotice && result && typeof result === "object" && !Array.isArray(result)
            ? { notice: db.reconnectNotice, ...(result as Record<string, unknown>) }
            : result;
        db.reconnectNotice = null;
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        const info = describeError(err);
        if (/^ORA-(01017|28000|28001)$/.test(info.error)) {
          (info as unknown as Record<string, unknown>).hint =
            "Login failed. Check ORACLE_USER, ORACLE_PASSWORD and ORACLE_PRIVILEGE in the env block of settings.json.";
        } else if (/^(ORA-12514|ORA-12541|ORA-12154|NJS-5\d\d)$/.test(info.error)) {
          (info as unknown as Record<string, unknown>).hint =
            `Cannot reach ${config.connectString}. Check that the database and listener are running (lsnrctl status) and that ORACLE_HOST, ORACLE_PORT and ORACLE_SERVICE are correct.`;
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
      await db?.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("close", () => void shutdown());

  await server.connect(new StdioServerTransport());
  log(
    config
      ? `ready: ${tools.length} tools, ${config.user}@${config.connectString}${config.privilege ? ` as ${config.privilege}` : ""}${config.readOnly ? " (read-only)" : ""}`
      : "started without valid configuration"
  );
}

main().catch((e) => {
  log(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
