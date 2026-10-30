// Configuration comes from environment variables only. A connection string on
// the command line is visible to every process on the machine (ps, Task
// Manager), so it is refused outright.

const MODES = new Set(["readonly", "readwrite"]);

function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  if (argv.length > 0) {
    throw new Error(
      "Command-line arguments are not accepted. Set PG_MCP_URL in the server's env block instead, " +
        "so the connection string never appears in the process list."
    );
  }

  const connectionString = env.PG_MCP_URL ?? env.DATABASE_URL;
  if (!connectionString || connectionString.trim() === "") {
    throw new Error("PG_MCP_URL is not set (example: postgres://user@host:5432/db).");
  }

  const url = new URL(connectionString);
  if (url.searchParams.has("mode")) {
    throw new Error("Set the mode with PG_MCP_MODE, not a ?mode= query parameter.");
  }

  const mode = (env.PG_MCP_MODE ?? "readonly").trim().toLowerCase();
  if (!MODES.has(mode)) {
    throw new Error(`PG_MCP_MODE must be "readonly" or "readwrite", got "${env.PG_MCP_MODE}"`);
  }

  return {
    connectionString,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    host: url.hostname,
    user: decodeURIComponent(url.username),
    mode,
    statementTimeoutMs: intFromEnv("PG_MCP_STATEMENT_TIMEOUT_MS", 30_000, 100, 600_000),
    maxRows: intFromEnv("PG_MCP_MAX_ROWS", 500, 1, 50_000),
    maxCellChars: intFromEnv("PG_MCP_MAX_CELL_CHARS", 2_000, 50, 1_000_000),
  };
}
