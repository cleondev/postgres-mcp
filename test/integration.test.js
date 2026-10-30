// End-to-end tests over stdio against a real database. They touch only
// temporary tables, so they are safe to run against a shared database.
// Run with: PG_MCP_TEST_URL=postgres://user:pass@host:5432/db npm test
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const url = process.env.PG_MCP_TEST_URL;
const serverPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

async function connect(mode, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, PG_MCP_URL: url, PG_MCP_MODE: mode, PG_MCP_MAX_ROWS: "50", ...extraEnv },
    stderr: "ignore",
  });
  const client = new Client({ name: "postgres-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  return { isError: result.isError === true, text, json: result.isError ? null : JSON.parse(text) };
}

describe("readonly mode", { skip: !url && "PG_MCP_TEST_URL not set" }, () => {
  let client;
  before(async () => { client = await connect("readonly"); });
  after(async () => { await client?.close(); });

  test("exposes no write tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["connection_info", "describe_table", "list_tables", "query"]);
  });

  test("runs a select", async () => {
    const r = await call(client, "query", { sql: "select 1 as one, 'a' as two" });
    assert.deepEqual(r.json.rows, [{ one: 1, two: "a" }]);
  });

  test("caps rows through the cursor", async () => {
    const r = await call(client, "query", { sql: "select g from generate_series(1, 1000) g;" });
    assert.equal(r.json.rowCount, 50);
    assert.equal(r.json.truncated, true);
  });

  test("rejects two statements (the upstream COMMIT; DROP bypass)", async () => {
    for (const sql of ["select 1; select 2", "commit; create temp table x(i int)", "select 1; commit"]) {
      const r = await call(client, "query", { sql });
      assert.ok(r.isError, sql);
    }
  });

  test("rejects transaction control", async () => {
    const r = await call(client, "query", { sql: "/* hi */ COMMIT" });
    assert.ok(r.isError);
    assert.match(r.text, /Transaction control/);
  });

  test("cannot write, even to a temp table", async () => {
    const r = await call(client, "query", { sql: "create temp table mcp_probe(i int)" });
    assert.ok(r.isError);
    assert.match(r.text, /read-only transaction|25006/);
  });

  test("cannot flip the transaction to read-write", async () => {
    const r = await call(client, "query", { sql: "select set_config('transaction_read_only', 'off', true)" });
    assert.ok(r.isError);
  });

  test("statement timeout cancels a slow query", async () => {
    const slow = await connect("readonly", { PG_MCP_STATEMENT_TIMEOUT_MS: "300" });
    try {
      const r = await call(slow, "query", { sql: "select pg_sleep(2)" });
      assert.ok(r.isError);
      assert.match(r.text, /57014/);
    } finally {
      await slow.close();
    }
  });

  test("lists tables and reports connection safety", async () => {
    assert.ok(Array.isArray((await call(client, "list_tables", {})).json.rows));
    const info = (await call(client, "connection_info", {})).json;
    assert.equal(info.mode, "readonly");
    assert.ok(Array.isArray(info.warnings));
  });
});

describe("readwrite mode", { skip: !url && "PG_MCP_TEST_URL not set" }, () => {
  let client;
  before(async () => { client = await connect("readwrite"); });
  after(async () => { await client?.close(); });

  test("transaction commits atomically and dry_run rolls back", async () => {
    const statements = [
      "create temp table mcp_probe(i int) on commit drop",
      "insert into mcp_probe select generate_series(1, 3)",
      "select count(*)::int as n from mcp_probe",
    ];
    const dry = (await call(client, "transaction", { statements, dry_run: true })).json;
    assert.equal(dry.committed, false);
    assert.equal(dry.statements[1].rowCount, 3);
    assert.deepEqual(dry.statements[2].returned.rows, [{ n: 3 }]);
    const real = (await call(client, "transaction", { statements })).json;
    assert.equal(real.committed, true);
  });

  test("execute still runs one statement only", async () => {
    const r = await call(client, "execute", { sql: "select 1; select 2", dry_run: true });
    assert.ok(r.isError);
  });

  test("a failing statement rolls the whole transaction back", async () => {
    const r = await call(client, "transaction", {
      statements: ["create temp table mcp_probe(i int) on commit drop", "select 1/0"],
    });
    assert.ok(r.isError);
    assert.match(r.text, /22012/);
  });
});
