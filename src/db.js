import pg from "pg";

// Dates and timestamps come back as the text Postgres sent. The default parser
// turns `timestamp without time zone` into a Date in the local time zone,
// which silently shifts the value.
const RAW_TEXT_TYPES = [
  pg.types.builtins.DATE,
  pg.types.builtins.TIMESTAMP,
  pg.types.builtins.TIMESTAMPTZ,
  pg.types.builtins.TIME,
  pg.types.builtins.TIMETZ,
  pg.types.builtins.INTERVAL,
];

const typeParsers = {
  getTypeParser(oid, format) {
    if (RAW_TEXT_TYPES.includes(oid)) return (value) => value;
    return pg.types.getTypeParser(oid, format);
  },
};

// Statements that would end, nest or reshape the transaction this server wraps
// every call in. Letting one through would let the rest of the call run
// outside the READ ONLY transaction (or outside the atomic one in readwrite).
const TRANSACTION_CONTROL =
  /^(begin|start|commit|end|rollback|abort|savepoint|release|prepare\s+transaction|set\s+transaction|set\s+session\s+characteristics)\b/i;

// Statements that can be fetched through a cursor, which caps the rows pulled
// from the server instead of materialising the whole result in memory.
const CURSOR_SAFE = /^(select|with|values|table)\b/i;

/** Strips leading whitespace, `--` line comments and (nested) block comments. */
export function stripLeadingComments(sql) {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i])) i++;
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    return sql.slice(i);
  }
}

export function assertNotTransactionControl(sql) {
  const head = stripLeadingComments(sql);
  if (head === "") throw new UserError("The SQL is empty.");
  if (TRANSACTION_CONTROL.test(head)) {
    throw new UserError(
      "Transaction control statements are not allowed; every call already runs in its own transaction."
    );
  }
}

export class UserError extends Error {}

export function createDb(config) {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    application_name: "postgres-mcp",
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    types: typeParsers,
    // A session-level backstop: even a statement that somehow ran outside the
    // per-call transaction would still be read-only.
    options:
      config.mode === "readonly"
        ? `-c default_transaction_read_only=on -c statement_timeout=${config.statementTimeoutMs}`
        : `-c statement_timeout=${config.statementTimeoutMs}`,
  });

  pool.on("error", (err) => {
    console.error(`[postgres-mcp] idle client error: ${err.message}`);
  });

  /**
   * Runs `work(client)` inside one transaction and always ends it: ROLLBACK
   * unless `commit` is true. Read-only calls take a snapshot first, so a later
   * attempt to flip the transaction to READ WRITE is rejected by the server.
   */
  async function inTransaction({ readOnly, commit }, work) {
    if (readOnly && commit) throw new Error("A read-only transaction is never committed.");
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN READ WRITE");
      await client.query(`SET LOCAL statement_timeout = ${config.statementTimeoutMs}`);
      if (readOnly) await client.query("SELECT 1");
      const result = await work(client);
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw err;
    } finally {
      client.release(discard);
    }
  }

  /** Runs exactly one statement. The extended protocol rejects `a; b`. */
  function runOne(client, sql) {
    assertNotTransactionControl(sql);
    return client.query({ text: sql, queryMode: "extended" });
  }

  /** Read-only query, fetching at most `limit + 1` rows so truncation is detectable. */
  async function readQuery(sql, limit) {
    return inTransaction({ readOnly: true, commit: false }, async (client) => {
      const head = stripLeadingComments(sql);
      if (CURSOR_SAFE.test(head)) {
        assertNotTransactionControl(sql);
        const body = sql.trim().replace(/;\s*$/, "");
        await client.query({ text: `DECLARE mcp_cursor NO SCROLL CURSOR FOR ${body}\n`, queryMode: "extended" });
        return client.query(`FETCH FORWARD ${limit + 1} FROM mcp_cursor`);
      }
      return runOne(client, sql);
    });
  }

  /** Parameterised helper for the server's own catalog queries. */
  async function catalogQuery(text, values) {
    return inTransaction({ readOnly: true, commit: false }, (client) => client.query(text, values));
  }

  async function write(statements, { dryRun }) {
    if (config.mode !== "readwrite") throw new UserError("This server is read-only.");
    return inTransaction({ readOnly: false, commit: !dryRun }, async (client) => {
      const results = [];
      for (const sql of statements) results.push(await runOne(client, sql));
      return results;
    });
  }

  return { pool, readQuery, catalogQuery, write, close: () => pool.end() };
}
