/** Shared helpers: identifier handling, value normalisation, SQL classification, script splitting. */

export class ToolError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
  }
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const SIMPLE_IDENT = /^[A-Za-z][A-Za-z0-9_$#]*$/;

/**
 * Returns the name as it is stored in the data dictionary.
 * `hr` -> `HR`; `"MixedCase"` (given with double quotes) -> `MixedCase`.
 */
export function dictName(input: string, what = "identifier"): string {
  const s = String(input ?? "").trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    if (inner === "" || inner.includes('"') || inner.includes("\0") || inner.length > 128) {
      throw new ToolError(`Invalid ${what}: ${input}`);
    }
    return inner;
  }
  if (!SIMPLE_IDENT.test(s) || s.length > 128) {
    throw new ToolError(
      `Invalid ${what}: "${input}". Use a plain Oracle name (letters, digits, _ $ #) or wrap a case-sensitive name in double quotes.`
    );
  }
  return s.toUpperCase();
}

/** Quoted identifier that is safe to embed in SQL text. */
export function q(input: string, what = "identifier"): string {
  return `"${dictName(input, what)}"`;
}

/** Quoted "SCHEMA"."OBJECT". */
export function qn(schema: string, name: string): string {
  return `${q(schema, "schema")}.${q(name, "object name")}`;
}

/** Unquoted, strictly validated name (container names, parameter names...). */
export function plainName(input: string, what = "name"): string {
  const s = String(input ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(s) || s.length > 128) {
    throw new ToolError(`Invalid ${what}: "${input}"`);
  }
  return s.toUpperCase();
}

/** SQL string literal with escaped single quotes. */
export function lit(value: string): string {
  if (value.includes("\0")) throw new ToolError("Invalid string value");
  return `'${value.replace(/'/g, "''")}'`;
}

/** Validates a size clause such as 500M, 2G, 1024K. Returns the upper-cased clause. */
export function sizeClause(input: string, what = "size"): string {
  const s = String(input ?? "").trim().toUpperCase().replace(/\s+/g, "").replace(/B$/, "");
  if (!/^\d+[KMGT]?$/.test(s)) {
    throw new ToolError(`Invalid ${what}: "${input}". Use e.g. 500M, 2G or a byte count.`);
  }
  return s;
}

export function sizeToBytes(clause: string): number {
  const m = /^(\d+)([KMGT]?)$/.exec(clause);
  if (!m) throw new ToolError(`Invalid size: ${clause}`);
  const factor = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2] as "" | "K" | "M" | "G" | "T"];
  return Number(m[1]) * factor;
}

export function mb(bytes: number | null | undefined): number {
  return Math.round(((bytes ?? 0) / 1048576) * 10) / 10;
}

/** Turns a user pattern into a LIKE pattern: adds % on both sides unless the caller used % himself. */
export function likePattern(input: string | undefined): string | null {
  if (input === undefined || input === null || String(input).trim() === "") return null;
  const s = String(input).trim();
  return s.includes("%") ? s : `%${s}%`;
}

// ---------------------------------------------------------------------------
// Value normalisation for JSON output
// ---------------------------------------------------------------------------

export const MAX_TEXT = 4000;

export function normalizeValue(v: unknown, truncate = true): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) {
    const limit = truncate ? 256 : v.length;
    const hex = v.subarray(0, limit).toString("hex");
    return v.length > limit ? `${hex}…[${v.length} bytes total]` : hex;
  }
  if (typeof v === "string") {
    if (truncate && v.length > MAX_TEXT) return `${v.slice(0, MAX_TEXT)}…[+${v.length - MAX_TEXT} chars]`;
    return v;
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => normalizeValue(x, truncate));
  if (typeof v === "object") {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Binds
// ---------------------------------------------------------------------------

export type Binds = Record<string, unknown> | unknown[];

export function parseBinds(json: string | undefined): Binds {
  if (json === undefined || json === null || String(json).trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(json));
  } catch (e) {
    throw new ToolError(`binds_json is not valid JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new ToolError('binds_json must be a JSON object like {"id": 1} or an array like [1, "x"].');
  }
  const check = (x: unknown): void => {
    if (x !== null && !["string", "number", "boolean"].includes(typeof x)) {
      throw new ToolError("Bind values must be strings, numbers, booleans or null.");
    }
  };
  if (Array.isArray(parsed)) parsed.forEach(check);
  else Object.values(parsed as Record<string, unknown>).forEach(check);
  return parsed as Binds;
}

// ---------------------------------------------------------------------------
// SQL classification
// ---------------------------------------------------------------------------

/** Removes comments and replaces string literals / quoted identifiers by placeholders. */
export function stripSql(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if ((c === "q" || c === "Q") && d === "'" && i + 2 < n && !/[A-Za-z0-9_$#]/.test(sql[i - 1] ?? " ")) {
      const open = sql[i + 2];
      const close = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
      const end = sql.indexOf(`${close}'`, i + 3);
      i = end === -1 ? n : end + 2;
      out += "''";
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      out += "''";
      continue;
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      i = end === -1 ? n : end + 1;
      out += '"x"';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const PLSQL_START =
  /^\s*(BEGIN|DECLARE|<<|CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(AND\s+(RESOLVE|COMPILE)\s+)?(NOFORCE\s+|FORCE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY|JAVA)\b)/i;

export function isPlsql(sql: string): boolean {
  return PLSQL_START.test(stripSql(sql));
}

export function isQuery(sql: string): boolean {
  const s = stripSql(sql).replace(/^[\s(]+/, "");
  return /^(SELECT|WITH)\b/i.test(s);
}

/** Finds a keyword in stripped SQL, ignoring occurrences nested in parentheses. */
function hasTopLevelKeyword(sql: string, keyword: string): boolean {
  let depth = 0;
  let cursor = 0;
  const re = /[A-Za-z][A-Za-z0-9_$#]*/g;
  for (let match = re.exec(sql); match; match = re.exec(sql)) {
    // Count parentheses between words, keeping quoted strings/comments out via stripSql().
    for (let i = cursor; i < match.index; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && match[0].toUpperCase() === keyword) return true;
    cursor = re.lastIndex;
  }
  return false;
}

/** Returns a reason when the statement is destructive / hard to undo, otherwise null. */
export function destructiveReason(sql: string): string | null {
  const s = stripSql(sql).trim();
  if (isPlsql(sql)) {
    const m = /\b(DROP|TRUNCATE|PURGE|SHUTDOWN)\b|\bALTER\s+(SYSTEM|DATABASE|PLUGGABLE)\b/i.exec(
      // dynamic SQL inside the block lives in string literals, so look at the raw text here
      sql.replace(/--.*$/gm, "")
    );
    return m ? `PL/SQL block contains ${m[0].toUpperCase().replace(/\s+/g, " ")}` : null;
  }
  if (/^(DROP|TRUNCATE|PURGE|SHUTDOWN)\b/i.test(s)) return `${s.split(/\s+/)[0].toUpperCase()} statement`;
  if (/^ALTER\s+(SYSTEM|DATABASE|PLUGGABLE)\b/i.test(s)) return s.split(/\s+/).slice(0, 2).join(" ").toUpperCase();
  if (/^(DELETE|UPDATE)\b/i.test(s) && !hasTopLevelKeyword(s, "WHERE")) {
    return `${s.split(/\s+/)[0].toUpperCase()} without WHERE`;
  }
  if (/^ALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(s)) return "ALTER TABLE ... DROP";
  return null;
}

/** Removes the SQL*Plus terminator from a single statement. */
export function cleanStatement(sql: string): string {
  let s = sql.trim();
  s = s.replace(/\n\s*\/\s*$/, "").trim();
  if (!isPlsql(s)) s = s.replace(/;\s*$/, "").trim();
  return s;
}

// ---------------------------------------------------------------------------
// SQL*Plus style script splitting
// ---------------------------------------------------------------------------

const SQLPLUS_COMMAND =
  /^\s*(SET|PROMPT|SPOOL|WHENEVER|EXIT|QUIT|REM|REMARK|DEFINE|UNDEFINE|COLUMN|COL|SHOW|CONNECT|CONN|DISCONNECT|CLEAR|TTITLE|BTITLE|BREAK|COMPUTE|PAUSE|ACCEPT|VARIABLE|VAR|PRINT|HOST|TIMING|DESC|DESCRIBE|EXEC|EXECUTE|@@?)(\s|$|(?<=@))/i;

interface ScanState {
  block: boolean;
  str: boolean;
  qEnd: string;
  ident: boolean;
}

/** Scans one line starting at `from`. Returns the index of a terminating ';' or -1. */
function scanLine(line: string, from: number, st: ScanState): number {
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    const d = line[i + 1];
    if (st.block) {
      if (c === "*" && d === "/") {
        st.block = false;
        i++;
      }
      continue;
    }
    if (st.str) {
      if (st.qEnd) {
        if (c === st.qEnd && d === "'") {
          st.str = false;
          st.qEnd = "";
          i++;
        }
      } else if (c === "'") {
        if (d === "'") i++;
        else st.str = false;
      }
      continue;
    }
    if (st.ident) {
      if (c === '"') st.ident = false;
      continue;
    }
    if (c === "-" && d === "-") return -1;
    if (c === "/" && d === "*") {
      st.block = true;
      i++;
      continue;
    }
    if ((c === "q" || c === "Q") && d === "'" && i + 2 < line.length && !/[A-Za-z0-9_$#]/.test(line[i - 1] ?? " ")) {
      const open = line[i + 2];
      st.qEnd = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
      st.str = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      st.str = true;
      st.qEnd = "";
      continue;
    }
    if (c === '"') {
      st.ident = true;
      continue;
    }
    if (c === ";") return i;
  }
  return -1;
}

export interface SplitResult {
  statements: string[];
  skipped: string[];
}

/**
 * Splits a script the way SQL*Plus does: ';' ends plain SQL, a line containing only '/' ends
 * PL/SQL blocks and CREATE PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE. SQL*Plus commands are skipped.
 */
export function splitScript(script: string): SplitResult {
  const statements: string[] = [];
  const skipped: string[] = [];
  const lines = script.replace(/\r\n?/g, "\n").split("\n");
  let buf: string[] = [];
  let mode: "undecided" | "sql" | "plsql" = "undecided";
  const st: ScanState = { block: false, str: false, qEnd: "", ident: false };
  const inside = (): boolean => st.block || st.str || st.ident;

  const flush = (): void => {
    const text = buf.join("\n").trim();
    buf = [];
    mode = "undecided";
    st.block = st.str = st.ident = false;
    st.qEnd = "";
    if (stripSql(text).trim() !== "") statements.push(text);
  };

  const queue = [...lines];
  while (queue.length > 0) {
    const line = queue.shift() as string;

    if (!inside() && line.trim() === "/") {
      flush();
      continue;
    }
    if (mode === "undecided" && !inside()) {
      if (stripSql(buf.join("\n")).trim() === "") {
        if (line.trim() === "") continue;
        if (SQLPLUS_COMMAND.test(line) && !/^\s*SET\s+(ROLE|TRANSACTION|CONSTRAINTS?)\b/i.test(line)) {
          const execMatch = /^\s*(EXEC|EXECUTE)\s+(.+?);?\s*$/i.exec(line);
          if (execMatch && !/^\s*EXECUTE\s+IMMEDIATE\b/i.test(line)) {
            statements.push(`BEGIN ${execMatch[2]}; END;`);
          } else {
            skipped.push(line.trim());
          }
          continue;
        }
      }
    }
    if (mode === "undecided") {
      const probe = stripSql([...buf, line].join("\n")).trim();
      if (probe !== "") mode = isPlsql(probe) ? "plsql" : "sql";
    }

    if (mode === "plsql") {
      buf.push(line);
      let pos = 0;
      // keep the string/comment state in sync; ';' does not terminate here
      while (pos < line.length) {
        const idx = scanLine(line, pos, st);
        if (idx === -1) break;
        pos = idx + 1;
      }
      continue;
    }

    const idx = scanLine(line, 0, st);
    if (idx === -1 || mode === "undecided") {
      buf.push(line);
      continue;
    }
    buf.push(line.slice(0, idx));
    flush();
    const rest = line.slice(idx + 1);
    if (rest.trim() !== "") queue.unshift(rest);
  }
  flush();
  return { statements, skipped };
}
