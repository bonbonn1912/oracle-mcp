/** Tool definition format, JSON-schema generation (kept flat for Gemini) and argument coercion. */

import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ToolError } from "./util.js";

export type Risk = "R" | "W" | "D";

export interface ParamDef {
  type: "string" | "number" | "boolean" | "string[]";
  description: string;
  required?: boolean;
  enum?: readonly string[];
}

/** Access to the configured connections (default "local" plus servers from connections.json). */
export interface ConnectionManager {
  list(): Config[];
  active(): string;
  setActive(name: string): void;
  isOpen(name: string): boolean;
}

export interface Ctx {
  /** Database session of the connection this call is routed to. */
  db: Db;
  /** Settings of that connection. */
  config: Config;
  connections: ConnectionManager;
}

export type Args = Record<string, any>;

export interface ToolDef {
  name: string;
  description: string;
  /** R = read only, W = changes data/objects, D = destructive (preview unless confirm=true). */
  risk: Risk;
  /** Maintenance work that may run for minutes: the per-call timeout is lifted. */
  long?: boolean;
  /** Tool does not talk to a database, so it gets no "connection" parameter. */
  noConnection?: boolean;
  params: Record<string, ParamDef>;
  handler: (args: Args, ctx: Ctx) => Promise<unknown>;
}

export const CONFIRM: ParamDef = {
  type: "boolean",
  description:
    "Set to true to actually execute. Without it the tool only returns a preview of the SQL and the affected objects.",
};

const RISK_LABEL: Record<Risk, string> = {
  R: "Read-only.",
  W: "Modifies the database.",
  D: "Destructive: returns a preview unless confirm=true.",
};

export function toolDescription(t: ToolDef): string {
  return `${t.description} [${RISK_LABEL[t.risk]}]`;
}

export const CONNECTION_PARAM_DESCRIPTION =
  "Optional: name of the database connection to use for this call (see oracle_list_connections). Default: the active connection.";

export function inputSchema(t: ToolDef, withConnection = false): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (withConnection && !t.noConnection && !("connection" in t.params)) {
    properties.connection = { type: "string", description: CONNECTION_PARAM_DESCRIPTION };
  }
  const required: string[] = [];
  for (const [name, p] of Object.entries(t.params)) {
    if (p.type === "string[]") {
      properties[name] = { type: "array", items: { type: "string" }, description: p.description };
    } else {
      const prop: Record<string, unknown> = { type: p.type, description: p.description };
      if (p.enum) prop.enum = [...p.enum];
      properties[name] = prop;
    }
    if (p.required) required.push(name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

/** Validates and coerces the arguments sent by the model (which may send "5" for 5 etc.). */
export function coerceArgs(t: ToolDef, raw: unknown): Args {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Args = {};
  for (const [name, p] of Object.entries(t.params)) {
    let v = input[name];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "" && p.type !== "string")) {
      if (p.required) throw new ToolError(`Missing required parameter "${name}".`);
      continue;
    }
    switch (p.type) {
      case "string": {
        if (typeof v === "number" || typeof v === "boolean") v = String(v);
        if (typeof v !== "string") throw new ToolError(`Parameter "${name}" must be a string.`);
        if (p.required && v.trim() === "") throw new ToolError(`Parameter "${name}" must not be empty.`);
        if (v.trim() === "" && !p.required) continue;
        if (p.enum) {
          const up = v.trim().toUpperCase();
          if (!p.enum.includes(up)) {
            throw new ToolError(`Parameter "${name}" must be one of: ${p.enum.join(", ")}.`);
          }
          v = up;
        }
        out[name] = v;
        break;
      }
      case "number": {
        const n = typeof v === "number" ? v : Number(String(v).trim());
        if (!Number.isFinite(n)) throw new ToolError(`Parameter "${name}" must be a number.`);
        out[name] = n;
        break;
      }
      case "boolean": {
        if (typeof v === "boolean") out[name] = v;
        else if (/^(true|1|yes|y)$/i.test(String(v).trim())) out[name] = true;
        else if (/^(false|0|no|n)$/i.test(String(v).trim())) out[name] = false;
        else throw new ToolError(`Parameter "${name}" must be true or false.`);
        break;
      }
      case "string[]": {
        let arr: unknown[];
        if (Array.isArray(v)) arr = v;
        else if (typeof v === "string") arr = v.split(",");
        else throw new ToolError(`Parameter "${name}" must be an array of strings.`);
        const list = arr.map((x) => String(x).trim()).filter((x) => x !== "");
        if (list.length === 0) {
          if (p.required) throw new ToolError(`Parameter "${name}" must not be empty.`);
          continue;
        }
        out[name] = list;
        break;
      }
    }
  }
  return out;
}

/** Standard answer of a destructive tool that was called without confirm=true. */
export function preview(statements: string[], impact: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executed: false,
    preview: true,
    message: "Nothing was executed. Review the statements and impact, then call the tool again with confirm=true.",
    statements,
    ...impact,
  };
}

/** Clamp helper for row limits. */
export function clamp(value: number | undefined, fallback: number, max: number): number {
  const v = value === undefined ? fallback : Math.floor(value);
  return Math.max(1, Math.min(v, max));
}
