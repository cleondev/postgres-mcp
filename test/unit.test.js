import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { assertNotTransactionControl, stripLeadingComments, UserError } from "../src/db.js";
import { formatRows } from "../src/format.js";

test("strips leading line and nested block comments", () => {
  assert.equal(stripLeadingComments("  -- a\n/* b /* c */ d */\n select 1"), "select 1");
  assert.equal(stripLeadingComments("-- only a comment"), "");
});

test("rejects transaction control even behind comments", () => {
  for (const sql of ["COMMIT", "  commit;", "/* x */ rollback", "-- c\nBEGIN", "end", "set transaction read write",
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE", "savepoint s", "prepare transaction 'x'", "start transaction"]) {
    assert.throws(() => assertNotTransactionControl(sql), UserError, sql);
  }
  assert.throws(() => assertNotTransactionControl("  -- nothing\n"), UserError);
  assert.doesNotThrow(() => assertNotTransactionControl("select 'commit'"));
  assert.doesNotThrow(() => assertNotTransactionControl("update t set ended = true"));
});

test("config refuses a connection string on the command line", () => {
  assert.throws(() => loadConfig(["postgres://u:p@h/db"], { PG_MCP_URL: "postgres://u@h/db" }), /not accepted/);
});

test("config defaults to readonly and rejects ?mode=", () => {
  const config = loadConfig([], { PG_MCP_URL: "postgres://u@h:5432/db" });
  assert.equal(config.mode, "readonly");
  assert.equal(config.database, "db");
  assert.throws(() => loadConfig([], { PG_MCP_URL: "postgres://u@h/db?mode=readonly" }), /PG_MCP_MODE/);
  assert.throws(() => loadConfig([], { PG_MCP_URL: "postgres://u@h/db", PG_MCP_MODE: "admin" }), /PG_MCP_MODE/);
  assert.throws(() => loadConfig([], {}), /PG_MCP_URL/);
});

test("caps rows and cuts long cells", () => {
  const result = {
    fields: [{ name: "a" }, { name: "b" }],
    rows: [{ a: "x".repeat(100), b: Buffer.alloc(8) }, { a: "y", b: null }, { a: "z", b: null }],
  };
  const out = formatRows(result, { maxRows: 2, maxCellChars: 10 });
  assert.equal(out.rowCount, 2);
  assert.equal(out.truncated, true);
  assert.match(out.rows[0].a, /^x{10}\.\.\. <truncated, 100 chars>$/);
  assert.equal(out.rows[0].b, "<bytea 8 bytes>");
});
