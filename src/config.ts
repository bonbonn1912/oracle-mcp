/** Configuration read from environment variables (set via the Gemini settings.json "env" block). */

export interface Config {
  user: string;
  password: string;
  connectString: string;
  privilege: "SYSDBA" | "SYSOPER" | "";
  readOnly: boolean;
  maxRows: number;
  callTimeoutMs: number;
  exportDir: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return Math.floor(n);
}

/** Gemini leaves "${VAR}" untouched when VAR is not set; treat that as "not set". */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === "" || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v)) return undefined;
  return v;
}

export function loadConfig(): Config {
  const user = env("ORACLE_USER") ?? "sys";
  const password = env("ORACLE_PASSWORD");
  if (!password) {
    throw new Error(
      "ORACLE_PASSWORD is not set. Add it to the \"env\" block of the MCP server entry in settings.json " +
        "(or export it in the shell that starts Gemini)."
    );
  }

  const host = env("ORACLE_HOST") ?? "localhost";
  const port = env("ORACLE_PORT") ?? "1521";
  const service = env("ORACLE_SERVICE") ?? "XEPDB1";
  const connectString = env("ORACLE_CONNECT_STRING") ?? `${host}:${port}/${service}`;

  let privilege = (env("ORACLE_PRIVILEGE") ?? "").toUpperCase();
  if (!env("ORACLE_PRIVILEGE") && user.toLowerCase() === "sys") privilege = "SYSDBA";
  if (privilege === "NONE" || privilege === "NORMAL") privilege = "";
  if (privilege !== "" && privilege !== "SYSDBA" && privilege !== "SYSOPER") {
    throw new Error(`ORACLE_PRIVILEGE must be SYSDBA, SYSOPER or empty, got "${privilege}"`);
  }

  return {
    user,
    password,
    connectString,
    privilege: privilege as Config["privilege"],
    readOnly: /^(1|true|yes|on)$/i.test(env("ORACLE_READ_ONLY") ?? ""),
    maxRows: intEnv("ORACLE_MAX_ROWS", 200),
    callTimeoutMs: intEnv("ORACLE_CALL_TIMEOUT_MS", 60000),
    exportDir: env("ORACLE_EXPORT_DIR") ?? "./exports",
  };
}
